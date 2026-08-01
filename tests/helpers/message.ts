import type { IncomingMessage } from "../../src/domain/types";

type MessageOverrides = Omit<Partial<IncomingMessage>, "source"> & {
  source?: Partial<IncomingMessage["source"]>;
};

export function message(overrides: MessageOverrides = {}): IncomingMessage {
  const base: IncomingMessage = {
    schemaVersion: 1,
    key: "broker/topic/message",
    identityKind: "envelope-id",
    source: {
      connectionId: "primary",
      brokerHash: "broker",
      topic: "test-topic",
      messageId: "AbCd123456",
      protocolVersion: 5,
      matchingFilters: ["test/#"],
    },
    publishedAtMs: Date.UTC(2026, 6, 29, 4, 5, 6, 7),
    receivedAtMs: Date.UTC(2026, 6, 29, 4, 5, 7, 8),
    title: "",
    body: "hello",
    priority: 3,
    tags: [],
    delivery: { qos: 1, retain: false, duplicate: false },
    payload: { byteLength: 5, sha256: "hash", text: "hello" },
    userProperties: {},
    unknownFields: [],
  };
  return {
    ...base,
    ...overrides,
    source: { ...base.source, ...overrides.source },
  };
}
