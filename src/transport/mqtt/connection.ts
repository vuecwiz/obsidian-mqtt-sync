import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import type {
  ConnectionConfigV1,
  ConnectionTelemetry,
  IncomingMessage,
  TransportFault,
} from "../../domain/types";
import { fullJitterBackoff } from "../../shared/backoff";
import { normalizeMqttMessage } from "./normalizer";

export interface ConnectionSink {
  accept(message: IncomingMessage): Promise<void>;
  ignored(event: string): Promise<void>;
  fault(fault: TransportFault): void;
  statusChanged?(status: ConnectionTelemetry["status"]): void;
}

export type MqttClientFactory = (url: string, options: IClientOptions) => MqttClient;

export class MQTTConnectionRunner {
  private client?: MqttClient;
  private stopped = true;
  private reconnectTimer?: number;
  private serial = Promise.resolve();
  readonly telemetry: ConnectionTelemetry;

  constructor(
    private readonly config: ConnectionConfigV1,
    private readonly maxPayloadBytes: number,
    private readonly dedupeWindowSeconds: number,
    private readonly sink: ConnectionSink,
    private readonly factory: MqttClientFactory = mqtt.connect,
  ) {
    this.telemetry = { connectionId: config.id, status: "stopped", reconnectAttempts: 0 };
  }

  start(parentSignal?: AbortSignal): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (parentSignal)
      parentSignal.addEventListener("abort", () => void this.stop(), { once: true });
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const client = this.client;
    this.client = undefined;
    if (client) await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    await this.serial;
    this.setStatus("stopped");
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus("connecting");
    const options = clientOptions(this.config);
    const client = this.factory(this.config.brokerUrl, options);
    this.client = client;
    client.on("connect", (packet) => {
      if (this.stopped || client !== this.client) return;
      this.telemetry.lastConnectedAtMs = Date.now();
      this.telemetry.sessionPresent = Boolean(packet.sessionPresent);
      this.telemetry.reconnectAttempts = 0;
      this.subscribe(client);
    });
    client.on("message", (topic, payload, packet) => {
      this.telemetry.lastEventAtMs = Date.now();
      this.serial = this.serial
        .then(async () => {
          const message = normalizeMqttMessage(
            this.config,
            topic,
            payload,
            packet,
            Date.now(),
            this.maxPayloadBytes,
            this.dedupeWindowSeconds,
          );
          await this.sink.accept(message);
        })
        .catch((error) => this.report(error));
    });
    client.on("error", (error) => this.report(error));
    client.on("close", () => {
      if (client === this.client) this.client = undefined;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private subscribe(client: MqttClient): void {
    const subscriptions = Object.fromEntries(
      this.config.subscriptions
        .filter((item) => item.enabled)
        .map((item) => [
          item.filter,
          { qos: item.qos, nl: item.noLocal, rap: item.retainAsPublished, rh: item.retainHandling },
        ]),
    );
    const count = Object.keys(subscriptions).length;
    this.telemetry.subscriptionCount = count;
    if (!count) {
      this.setStatus("connected");
      return;
    }
    this.setStatus("subscribing");
    client.subscribe(subscriptions, (error) => {
      if (error) {
        this.report(error);
        client.end(true);
        return;
      }
      this.setStatus("connected");
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.setStatus("backoff");
    const wait = fullJitterBackoff(
      this.telemetry.reconnectAttempts,
      this.config.reconnect.minMs,
      this.config.reconnect.maxMs,
    );
    this.telemetry.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, wait);
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : "MQTT transport failure";
    const code = /auth|not authorized|bad user/i.test(message)
      ? "AUTH_FAILED"
      : /certificate|tls|ssl/i.test(message)
        ? "TLS_FAILED"
        : "NETWORK_ERROR";
    const fault = { code, message, retryable: code === "NETWORK_ERROR" };
    this.telemetry.lastFault = fault;
    this.sink.fault(fault);
    if (!fault.retryable) this.setStatus(code === "AUTH_FAILED" ? "auth_failed" : "error");
  }

  private setStatus(status: ConnectionTelemetry["status"]): void {
    if (this.telemetry.status !== status) {
      this.telemetry.status = status;
      this.sink.statusChanged?.(status);
    }
  }
}

export function clientOptions(config: ConnectionConfigV1): IClientOptions {
  return {
    protocolVersion: config.protocolVersion,
    clientId: config.clientId,
    username: config.auth.username || undefined,
    password: config.auth.password || undefined,
    keepalive: config.keepAliveSeconds,
    connectTimeout: config.connectTimeoutMs,
    clean: config.cleanStart,
    reconnectPeriod: 0,
    resubscribe: false,
    rejectUnauthorized: true,
    ca: config.tls.caPem,
    cert: config.tls.clientCertificatePem,
    key: config.tls.privateKeyPem,
    properties:
      config.protocolVersion === 5
        ? { sessionExpiryInterval: config.cleanStart ? 0 : config.sessionExpirySeconds }
        : undefined,
  };
}

export async function testMqttConnection(
  connection: ConnectionConfigV1,
  factory: MqttClientFactory = mqtt.connect,
  signal?: AbortSignal,
): Promise<void> {
  if (!connection.clientId.trim()) throw new Error("MQTT Client ID is required");
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const suffix = `-test-${Math.random().toString(16).slice(2, 10)}`;
  const clientId = `${connection.clientId.slice(0, Math.max(1, 128 - suffix.length))}${suffix}`;
  const client = factory(
    connection.brokerUrl,
    clientOptions({
      ...connection,
      clientId,
      cleanStart: true,
      sessionExpirySeconds: 0,
    }),
  );
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let abort = (): void => undefined;
    const timer = window.setTimeout(
      () => finish(new Error("MQTT connection test timed out")),
      connection.connectTimeoutMs,
    );
    const cleanup = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      client.removeAllListeners();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      client.end(true, {}, () => {
        if (error) reject(error);
        else resolve();
      });
    };
    abort = () => finish(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    client.once("error", finish);
    client.once("connect", () => finish());
  });
}

export async function mqttPublish(
  connection: ConnectionConfigV1,
  topic: string,
  payload: unknown,
  qos: 0 | 1 | 2,
  retain: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const client = mqtt.connect(
    connection.brokerUrl,
    clientOptions({
      ...connection,
      clientId: `${connection.clientId}-result-${Math.random().toString(16).slice(2, 10)}`,
      cleanStart: true,
      sessionExpirySeconds: 0,
    }),
  );
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      client.removeAllListeners();
    };
    const finish = (error?: Error) =>
      client.end(true, {}, () => {
        cleanup();
        if (error) reject(error);
        else resolve();
      });
    const abort = () => finish(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    client.once("error", finish);
    client.once("connect", () =>
      client.publish(
        topic,
        JSON.stringify(payload),
        {
          qos,
          retain,
          properties:
            connection.protocolVersion === 5
              ? { contentType: "application/json", payloadFormatIndicator: true }
              : undefined,
        },
        (error) => finish(error ?? undefined),
      ),
    );
  });
}
