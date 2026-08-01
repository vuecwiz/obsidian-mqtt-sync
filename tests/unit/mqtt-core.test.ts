import { createDefaultSettings } from "../../src/settings/defaults";
import { validateSettings } from "../../src/settings/validate";
import { canonicalBrokerUrl, normalizeMqttMessage } from "../../src/transport/mqtt/normalizer";
import { isValidTopicFilter, topicMatchesFilter } from "../../src/transport/mqtt/topic";
import type { ConnectionConfigV1 } from "../../src/domain/types";
import { migrateSettings } from "../../src/settings/migrate";
import { testMqttConnection, type MqttClientFactory } from "../../src/transport/mqtt/connection";

function connection() {
  const settings = createDefaultSettings();
  const value: ConnectionConfigV1 = {
    id: "primary",
    name: "Primary",
    brokerUrl: "mqtt://127.0.0.1:1883",
    protocolVersion: 5,
    clientId: "obsidian-test",
    auth: {},
    tls: {},
    allowInsecureRemote: false,
    keepAliveSeconds: 60,
    connectTimeoutMs: 30_000,
    cleanStart: false,
    sessionExpirySeconds: 86_400,
    subscriptions: [
      {
        filter: "sensors/+/reading",
        qos: 1,
        noLocal: false,
        retainAsPublished: true,
        retainHandling: 1,
        enabled: true,
      },
    ],
    reconnect: { minMs: 100, maxMs: 1_000, jitterRatio: 1 },
    useCorrelationDataAsId: false,
  };
  settings.connections = [value];
  return { settings, value };
}

describe("MQTT settings and topic semantics", () => {
  it("fails closed when incompatible protocol settings are encountered", () => {
    const migrated = migrateSettings({
      schemaVersion: 1,
      enabled: true,
      connections: [{ baseUrl: "https://example.invalid", topics: ["old"] }],
    });
    expect(migrated.enabled).toBe(false);
    expect(migrated.connections).toEqual([]);
  });
  it("accepts supported URLs and restricts insecure remote brokers", () => {
    expect(canonicalBrokerUrl("mqtt://127.0.0.1:1883")).toContain("mqtt://127.0.0.1:1883");
    expect(() => canonicalBrokerUrl("mqtt://broker.example:1883")).toThrow(/loopback/u);
    expect(canonicalBrokerUrl("mqtts://broker.example:8883")).toContain("mqtts:");
    expect(() => canonicalBrokerUrl("https://broker.example")).toThrow(/mqtt/u);
  });
  it("implements +, #, empty levels, and the $ namespace boundary", () => {
    expect(isValidTopicFilter("a/+/c/#")).toBe(true);
    expect(isValidTopicFilter("a/#/c")).toBe(false);
    expect(topicMatchesFilter("a/+/c/#", "a//c/d")).toBe(true);
    expect(topicMatchesFilter("#", "$SYS/broker")).toBe(false);
    expect(topicMatchesFilter("$SYS/#", "$SYS/broker")).toBe(true);
  });
  it("rejects result loops and invalid session combinations", () => {
    const { settings, value } = connection();
    value.result = { topic: "sensors/a/reading", qos: 1, retain: false, privacy: "minimal" };
    expect(validateSettings(settings).map((entry) => entry.code)).toContain("RESULT_LOOP");
    value.result.topic = "obsidian/result";
    value.cleanStart = true;
    value.sessionExpirySeconds = 10;
    expect(validateSettings(settings).map((entry) => entry.code)).toContain("SESSION");
  });
  it("rejects duplicate Client IDs within one device configuration", () => {
    const { settings, value } = connection();
    settings.connections.push({ ...structuredClone(value), id: "secondary" });
    expect(validateSettings(settings).map((entry) => entry.code)).toContain("DUPLICATE_CLIENT_ID");
  });
  it("tests a broker handshake with a temporary clean client and no subscription", async () => {
    const { value } = connection();
    const client = new EventEmitter() as EventEmitter & MqttClient;
    client.end = vi.fn((_force, _options, callback) => {
      callback?.();
      return client;
    }) as unknown as MqttClient["end"];
    const factory = vi.fn(((_url, _options) => {
      queueMicrotask(() => client.emit("connect", {}));
      return client;
    }) satisfies MqttClientFactory);

    await testMqttConnection(value, factory);

    expect(factory).toHaveBeenCalledWith(
      value.brokerUrl,
      expect.objectContaining({ clean: true, protocolVersion: 5 }),
    );
    const options = factory.mock.calls[0]![1];
    expect(options.clientId).toMatch(/^obsidian-test-test-/u);
    expect(options.clientId).not.toBe(value.clientId);
    expect(client.listenerCount("message")).toBe(0);
    expect(client.end).toHaveBeenCalled();
  });

  it("cancels a pending broker handshake and cleans up its client and timer", async () => {
    vi.useFakeTimers();
    const { value } = connection();
    const client = new EventEmitter() as EventEmitter & MqttClient;
    client.end = vi.fn((_force, _options, callback) => {
      callback?.();
      return client;
    }) as unknown as MqttClient["end"];
    const factory: MqttClientFactory = () => client;
    const controller = new AbortController();

    const pending = testMqttConnection(value, factory, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(client.end).toHaveBeenCalledWith(true, {}, expect.any(Function));
    expect(client.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe("MQTT identity", () => {
  it("uses envelope IDs, ignores packet IDs, and preserves delivery metadata", () => {
    const { value } = connection();
    const body = Buffer.from(
      JSON.stringify({ schema: "obsidian.mqtt-sync.message.v1", id: "stable-1", text: "hello" }),
    );
    const first = normalizeMqttMessage(
      value,
      "sensors/a/reading",
      body,
      {
        qos: 2,
        retain: false,
        dup: false,
        messageId: 10,
        properties: { contentType: "application/json" },
      },
      1000,
    );
    const replay = normalizeMqttMessage(
      value,
      "sensors/a/reading",
      body,
      {
        qos: 2,
        retain: false,
        dup: true,
        messageId: 999,
        properties: { contentType: "application/json" },
      },
      2000,
    );
    expect(first.key).toBe(replay.key);
    expect(replay.delivery).toMatchObject({ qos: 2, duplicate: true, packetId: 999 });
    expect(first.identityKind).toBe("envelope-id");
  });
  it("dedupes retained replay but distinguishes changed retained payload", () => {
    const { value } = connection();
    const one = normalizeMqttMessage(
      value,
      "sensors/a/reading",
      Buffer.from("one"),
      { qos: 1, retain: true },
      1000,
    );
    const replay = normalizeMqttMessage(
      value,
      "sensors/a/reading",
      Buffer.from("one"),
      { qos: 1, retain: true },
      900000,
    );
    const changed = normalizeMqttMessage(
      value,
      "sensors/a/reading",
      Buffer.from("two"),
      { qos: 1, retain: true },
      900000,
    );
    expect(one.key).toBe(replay.key);
    expect(changed.key).not.toBe(one.key);
  });
  it("bounds payloads and property counts", () => {
    const { value } = connection();
    expect(() => normalizeMqttMessage(value, "a", Buffer.alloc(11), { qos: 0 }, 1, 10)).toThrow(
      /limit/u,
    );
    const properties = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`k${index}`, "v"]),
    );
    expect(() =>
      normalizeMqttMessage(value, "a", Buffer.from("x"), {
        qos: 0,
        properties: { userProperties: properties },
      }),
    ).toThrow(/properties/u);
  });
  it("rejects malformed protocol metadata and unsafe envelopes", () => {
    const { value } = connection();
    expect(() => normalizeMqttMessage(value, "", Buffer.from("x"), { qos: 0 })).toThrow(/topic/u);
    expect(() => normalizeMqttMessage(value, "a", Buffer.from("x"), { qos: 3 })).toThrow(/QoS/u);
    expect(() =>
      normalizeMqttMessage(value, "a", Buffer.from("{"), {
        qos: 0,
        properties: { contentType: "application/json" },
      }),
    ).toThrow(/JSON/u);
    expect(() =>
      normalizeMqttMessage(
        value,
        "a",
        Buffer.from(
          JSON.stringify({
            schema: "obsidian.mqtt-sync.message.v1",
            attachment: { url: "file:///private/note", name: "note" },
          }),
        ),
        { qos: 0, properties: { contentType: "application/json" } },
      ),
    ).toThrow(/attachment/u);
    expect(() =>
      normalizeMqttMessage(value, "a", Buffer.from("x"), {
        qos: 0,
        properties: { correlationData: Buffer.alloc(8193) },
      }),
    ).toThrow(/Correlation/u);
  });
});
import { EventEmitter } from "node:events";
import type { MqttClient } from "mqtt";
