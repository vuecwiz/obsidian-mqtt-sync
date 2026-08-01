import { domainToASCII } from "node:url";
import type { IncomingMessage, MqttQos, SubscriptionConfigV1 } from "../../domain/types";
import { sha256Hex } from "../../shared/crypto";
import { SyncError } from "../../shared/errors";
import { topicMatchesFilter } from "./topic";

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/iu;
export interface MqttPublishPacketLike {
  qos?: number;
  retain?: boolean;
  dup?: boolean;
  messageId?: number;
  properties?: {
    contentType?: string;
    payloadFormatIndicator?: boolean | number;
    userProperties?: Record<string, string | string[]>;
    responseTopic?: string;
    correlationData?: Uint8Array;
  };
}

export function canonicalBrokerUrl(raw: string, allowInsecureRemote = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SyncError("CONFIG_INVALID", "Invalid broker URL", false);
  }
  if (!["mqtt:", "mqtts:", "ws:", "wss:"].includes(url.protocol))
    throw new SyncError("CONFIG_INVALID", "Broker URL must use mqtt, mqtts, ws, or wss", false);
  if (url.username || url.password || url.search || url.hash)
    throw new SyncError(
      "CONFIG_INVALID",
      "Broker URL must not contain credentials, query, or fragment",
      false,
    );
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (["mqtt:", "ws:"].includes(url.protocol) && !loopback && !allowInsecureRemote)
    throw new SyncError(
      "CONFIG_INVALID",
      "Plain MQTT/WebSocket is limited to loopback unless explicitly allowed",
      false,
    );
  url.pathname = url.protocol.startsWith("ws") ? url.pathname || "/mqtt" : "";
  return url.toString().replace(/\/$/u, "");
}

export function extractFirstUrl(text: string): IncomingMessage["firstUrl"] {
  const match = text.match(URL_PATTERN);
  if (!match) return undefined;
  try {
    const raw = match[0].replace(/[.,!?;:]+$/u, "");
    const url = new URL(raw);
    const hostname = domainToASCII(url.hostname).toLowerCase();
    return hostname ? { raw, protocol: url.protocol as "http:" | "https:", hostname } : undefined;
  } catch {
    return undefined;
  }
}

function decodeUtf8(payload: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return undefined;
  }
}
function jsonDepth(value: unknown, depth = 0): number {
  if (depth > 32) return depth;
  if (!value || typeof value !== "object") return depth;
  return Math.max(
    depth,
    ...Object.values(value as Record<string, unknown>).map((item) => jsonDepth(item, depth + 1)),
  );
}
function envelope(value: unknown): Record<string, unknown> | undefined {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schema === "obsidian.mqtt-sync.message.v1"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeMqttMessage(
  connection: {
    id: string;
    brokerUrl: string;
    allowInsecureRemote: boolean;
    protocolVersion: 4 | 5;
    subscriptions: SubscriptionConfigV1[];
    useCorrelationDataAsId: boolean;
  },
  topic: string,
  payloadInput: Uint8Array,
  packet: MqttPublishPacketLike,
  receivedAtMs = Date.now(),
  maxPayloadBytes = 256 * 1024,
  dedupeWindowSeconds = 600,
): IncomingMessage {
  if (!topic || topic.includes("\0"))
    throw new SyncError("PROTOCOL_INVALID", "Invalid topic name", false);
  const payload = new Uint8Array(payloadInput);
  if (payload.byteLength > Math.min(maxPayloadBytes, 1024 * 1024))
    throw new SyncError("BODY_TOO_LARGE", "MQTT payload exceeds configured limit", false);
  const qos = packet.qos;
  if (qos !== 0 && qos !== 1 && qos !== 2)
    throw new SyncError("PROTOCOL_INVALID", "Invalid MQTT QoS", false);
  const properties = packet.properties ?? {};
  const correlation = properties.correlationData
    ? Buffer.from(properties.correlationData).toString("base64")
    : undefined;
  if (correlation && Buffer.byteLength(correlation, "base64") > 8192)
    throw new SyncError("PROTOCOL_INVALID", "Correlation data is too large", false);
  const userProperties: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(properties.userProperties ?? {})) {
    userProperties[key] = Array.isArray(value) ? value : [value];
  }
  if (Object.values(userProperties).reduce((sum, values) => sum + values.length, 0) > 64)
    throw new SyncError("PROTOCOL_INVALID", "Too many user properties", false);
  const text = decodeUtf8(payload);
  let json: unknown;
  if (text && (properties.contentType?.includes("json") || /^\s*[[{]/u.test(text))) {
    try {
      json = JSON.parse(text);
      if (jsonDepth(json) > 32) throw new Error();
    } catch {
      if (properties.contentType?.includes("json"))
        throw new SyncError("PROTOCOL_INVALID", "Invalid or too-deep JSON payload", false);
    }
  }
  const env = envelope(json);
  const body = typeof env?.text === "string" ? env.text : (text ?? "");
  const attachmentRaw =
    env?.attachment && typeof env.attachment === "object" && !Array.isArray(env.attachment)
      ? (env.attachment as Record<string, unknown>)
      : undefined;
  let attachment: IncomingMessage["attachment"];
  if (
    attachmentRaw &&
    typeof attachmentRaw.url === "string" &&
    typeof attachmentRaw.name === "string"
  ) {
    const url = new URL(attachmentRaw.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new SyncError("PROTOCOL_INVALID", "Unsafe attachment URL", false);
    attachment = {
      url: url.toString(),
      name: attachmentRaw.name,
      type: typeof attachmentRaw.contentType === "string" ? attachmentRaw.contentType : undefined,
      size: typeof attachmentRaw.size === "number" ? attachmentRaw.size : undefined,
      sha256: typeof attachmentRaw.sha256 === "string" ? attachmentRaw.sha256 : undefined,
    };
  }
  const brokerHash = sha256Hex(
    canonicalBrokerUrl(connection.brokerUrl, connection.allowInsecureRemote),
  ).slice(0, 24);
  const payloadHash = sha256Hex(payload);
  const retain = Boolean(packet.retain);
  const stableId = typeof env?.id === "string" && env.id ? env.id : undefined;
  const identityKind = stableId
    ? "envelope-id"
    : connection.useCorrelationDataAsId && correlation
      ? "correlation-data"
      : retain
        ? "retained"
        : "fingerprint";
  const identity =
    stableId ??
    (connection.useCorrelationDataAsId ? correlation : undefined) ??
    (retain
      ? `retained:${payloadHash}`
      : `bucket:${Math.floor(receivedAtMs / (Math.max(1, dedupeWindowSeconds) * 1000))}:${payloadHash}:${qos}`);
  const messageId = sha256Hex(`${brokerHash}\0${topic}\0${identity}`);
  return {
    schemaVersion: 1,
    key: `${brokerHash}/${encodeURIComponent(topic)}/${messageId}`,
    identityKind,
    source: {
      connectionId: connection.id,
      brokerHash,
      topic,
      messageId,
      protocolVersion: connection.protocolVersion,
      matchingFilters: connection.subscriptions
        .filter((item) => item.enabled && topicMatchesFilter(item.filter, topic))
        .map((item) => item.filter),
    },
    publishedAtMs: receivedAtMs,
    receivedAtMs,
    body,
    title: typeof env?.title === "string" ? env.title : "",
    priority:
      typeof env?.priority === "number" &&
      Number.isInteger(env.priority) &&
      env.priority >= 1 &&
      env.priority <= 5
        ? (env.priority as 1 | 2 | 3 | 4 | 5)
        : 3,
    tags: Array.isArray(env?.tags)
      ? env.tags.filter((item): item is string => typeof item === "string")
      : [],
    delivery: {
      qos: qos as MqttQos,
      retain,
      duplicate: Boolean(packet.dup),
      packetId: packet.messageId,
    },
    payload: { byteLength: payload.byteLength, sha256: payloadHash, text, json },
    contentType: properties.contentType,
    payloadFormatIndicator:
      properties.payloadFormatIndicator === undefined
        ? undefined
        : properties.payloadFormatIndicator
          ? 1
          : 0,
    userProperties,
    responseTopic: properties.responseTopic,
    correlationData: correlation,
    firstUrl: extractFirstUrl(
      `${typeof env?.title === "string" ? env.title : ""}\n${typeof env?.url === "string" ? env.url : ""}\n${body}`,
    ),
    attachment,
    unknownFields: [],
  };
}
