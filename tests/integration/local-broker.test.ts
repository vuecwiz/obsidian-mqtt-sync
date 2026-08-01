import { createServer, type Server } from "node:net";
import Aedes from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import {
  MQTTConnectionRunner,
  mqttPublish,
  testMqttConnection,
} from "../../src/transport/mqtt/connection";
import type { ConnectionConfigV1, IncomingMessage } from "../../src/domain/types";

describe("isolated local MQTT broker", () => {
  let broker: InstanceType<typeof Aedes>;
  let server: Server;
  let url: string;
  let clients: MqttClient[];

  beforeEach(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing broker address");
    url = `mqtt://127.0.0.1:${address.port}`;
    clients = [];
  });

  afterEach(async () => {
    await Promise.all(
      clients.map(
        (client) => new Promise<void>((resolve) => client.end(true, {}, () => resolve())),
      ),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  async function client(id: string): Promise<MqttClient> {
    const value = mqtt.connect(url, { clientId: id, protocolVersion: 4, reconnectPeriod: 0 });
    clients.push(value);
    await new Promise<void>((resolve, reject) => {
      value.once("connect", () => resolve());
      value.once("error", reject);
    });
    return value;
  }

  it("delivers wildcards, QoS 0/1, retained replay, and result publications", async () => {
    const subscriber = await client("subscriber");
    await new Promise<void>((resolve, reject) =>
      subscriber.subscribe("devices/+/state", { qos: 1 }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    const received: Array<{ topic: string; payload: string; qos: number; retain: boolean }> = [];
    subscriber.on("message", (topic, payload, packet) =>
      received.push({ topic, payload: payload.toString(), qos: packet.qos, retain: packet.retain }),
    );
    const publisher = await client("publisher");
    await new Promise<void>((resolve, reject) =>
      publisher.publish("devices/a/state", "one", { qos: 0 }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    await new Promise<void>((resolve, reject) =>
      publisher.publish("devices/b/state", "two", { qos: 1, retain: true }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    await vi.waitFor(() => expect(received).toHaveLength(2));
    const replay = await client("retained-reader");
    const retained = new Promise<{ payload: string; retain: boolean }>((resolve) =>
      replay.once("message", (_topic, payload, packet) =>
        resolve({ payload: payload.toString(), retain: packet.retain }),
      ),
    );
    await new Promise<void>((resolve, reject) =>
      replay.subscribe("devices/b/#", { qos: 1 }, (error) => (error ? reject(error) : resolve())),
    );
    await expect(retained).resolves.toEqual({ payload: "two", retain: true });
    expect(received.map((entry) => entry.topic)).toEqual(["devices/a/state", "devices/b/state"]);
  });

  it("runs the plugin transport, normalizes a publication, and publishes a result", async () => {
    const config: ConnectionConfigV1 = {
      id: "runner",
      name: "Runner",
      brokerUrl: url,
      protocolVersion: 4,
      clientId: "plugin-runner",
      auth: {},
      tls: {},
      allowInsecureRemote: false,
      keepAliveSeconds: 10,
      connectTimeoutMs: 2_000,
      cleanStart: true,
      sessionExpirySeconds: 0,
      subscriptions: [
        {
          filter: "input/+",
          qos: 1,
          noLocal: false,
          retainAsPublished: true,
          retainHandling: 0,
          enabled: true,
        },
      ],
      reconnect: { minMs: 10, maxMs: 100, jitterRatio: 1 },
      useCorrelationDataAsId: false,
      result: { topic: "result/processed", qos: 1, retain: false, privacy: "minimal" },
    };
    await testMqttConnection(config);
    const accepted: IncomingMessage[] = [];
    const runner = new MQTTConnectionRunner(config, 1024, 600, {
      accept: async (message) => {
        accepted.push(message);
      },
      ignored: async () => undefined,
      fault: (fault) => {
        throw new Error(fault.code);
      },
    });
    runner.start();
    await vi.waitFor(() => expect(runner.telemetry.status).toBe("connected"));
    const publisher = await client("runner-publisher");
    await new Promise<void>((resolve, reject) =>
      publisher.publish(
        "input/a",
        JSON.stringify({
          schema: "obsidian.mqtt-sync.message.v1",
          id: "integration-1",
          text: "hello",
        }),
        { qos: 1 },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    expect(accepted[0]).toMatchObject({
      body: "hello",
      identityKind: "envelope-id",
      delivery: { qos: 1 },
    });
    const resultReader = await client("result-reader");
    await new Promise<void>((resolve, reject) =>
      resultReader.subscribe("result/#", { qos: 1 }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    const result = new Promise<string>((resolve) =>
      resultReader.once("message", (_topic, payload) => resolve(payload.toString())),
    );
    await mqttPublish(
      config,
      "result/processed",
      { schema: "obsidian.mqtt-sync.result.v1", outcome: "succeeded" },
      1,
      false,
    );
    await expect(result).resolves.toContain("succeeded");
    await runner.stop();
  });
});
