import { normalizeMqttMessage } from "../../src/transport/mqtt/normalizer";

const connection = {
  id: "c",
  brokerUrl: "wss://broker.example/mqtt",
  allowInsecureRemote: false,
  protocolVersion: 5 as const,
  subscriptions: [
    {
      filter: "in/#",
      qos: 2 as const,
      noLocal: true,
      retainAsPublished: true,
      retainHandling: 1 as const,
      enabled: true,
    },
  ],
  useCorrelationDataAsId: true,
};

describe("MQTT 5 normalization contract", () => {
  it("maps payload, properties, response metadata, and envelope attachments", () => {
    const payload = Buffer.from(
      JSON.stringify({
        schema: "obsidian.mqtt-sync.message.v1",
        id: "app-42",
        text: "capture https://example.com/a",
        title: "Inbox",
        tags: ["clip"],
        priority: 4,
        attachment: {
          url: "https://files.example/a.png",
          name: "a.png",
          contentType: "image/png",
          size: 42,
          sha256: "a".repeat(64),
        },
      }),
    );
    const message = normalizeMqttMessage(connection, "in/device/1", payload, {
      qos: 2,
      retain: true,
      properties: {
        contentType: "application/json",
        payloadFormatIndicator: true,
        userProperties: { trace: ["a", "b"] },
        responseTopic: "reply/device/1",
        correlationData: Buffer.from("correlation"),
      },
    });
    expect(message).toMatchObject({
      body: "capture https://example.com/a",
      title: "Inbox",
      priority: 4,
      tags: ["clip"],
      delivery: { qos: 2, retain: true },
      contentType: "application/json",
      responseTopic: "reply/device/1",
      attachment: { name: "a.png", type: "image/png", size: 42 },
    });
    expect(message.userProperties.trace).toEqual(["a", "b"]);
    expect(message.correlationData).toBe(Buffer.from("correlation").toString("base64"));
  });
  it("does not grant attachment semantics to arbitrary JSON", () => {
    const message = normalizeMqttMessage(
      connection,
      "in/a",
      Buffer.from(
        JSON.stringify({ text: "x", attachment: { url: "https://files.example/a", name: "a" } }),
      ),
      { qos: 0, properties: { contentType: "application/json" } },
    );
    expect(message.attachment).toBeUndefined();
    expect(message.payload.json).toBeTruthy();
  });
});
