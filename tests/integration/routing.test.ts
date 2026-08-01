import { MessageProcessor } from "../../src/app/processor";
import { ResultOutboxService } from "../../src/app/result-outbox";
import type { ConnectionConfigV1, RuleV1 } from "../../src/domain/types";
import { AttachmentService } from "../../src/effects/attachment";
import { VaultWriter } from "../../src/effects/vault-writer";
import { DurableInboxService } from "../../src/inbox/durable-inbox";
import { createDefaultSettings } from "../../src/settings/defaults";
import { JsonStateStore } from "../../src/state/store";
import { MemoryStateAdapter } from "../helpers/memory-state-adapter";
import { MemoryVault } from "../helpers/memory-vault";
import { message } from "../helpers/message";

function connection(): ConnectionConfigV1 {
  return {
    id: "primary",
    name: "Local test",
    brokerUrl: "mqtt://127.0.0.1:1883",
    protocolVersion: 5,
    clientId: "mqtt-routing-test",
    auth: {},
    tls: {},
    allowInsecureRemote: false,
    keepAliveSeconds: 60,
    connectTimeoutMs: 30_000,
    cleanStart: true,
    sessionExpirySeconds: 0,
    subscriptions: [
      {
        filter: "events/#",
        qos: 1,
        noLocal: true,
        retainAsPublished: true,
        retainHandling: 2,
        enabled: true,
      },
    ],
    reconnect: { minMs: 1_000, maxMs: 60_000, jitterRatio: 1 },
    useCorrelationDataAsId: false,
  };
}

function rule(id: string, filter: string, notePathTemplate: string): RuleV1 {
  return {
    id,
    revision: 1,
    name: id,
    enabled: true,
    when: { all: [{ field: "topic", op: "matchesFilter", value: filter }] },
    action: {
      notePathTemplate,
      contentTemplateId: "inbox",
      insertion: "append",
    },
  };
}

describe("durable message distribution", () => {
  it("persists publications, chooses the first matching rule, and writes distinct Vault targets", async () => {
    const settings = createDefaultSettings();
    settings.connections = [connection()];
    settings.rules.rules = [
      rule("alerts", "events/+/alert", "MQTT Sync/Alerts.md"),
      rule("events", "events/#", "MQTT Sync/Events.md"),
    ];
    const store = new JsonStateStore(new MemoryStateAdapter(), "plugin");
    await store.load();
    const inbox = new DurableInboxService(store);
    const alert = message({
      key: "alert-key",
      source: { topic: "events/kitchen/alert" },
      body: "alarm",
      payload: { byteLength: 5, sha256: "alert", text: "alarm" },
    });
    const state = message({
      key: "state-key",
      source: { topic: "events/kitchen/state" },
      body: "normal",
      payload: { byteLength: 6, sha256: "state", text: "normal" },
    });
    await inbox.accept(alert, 1);
    await inbox.accept(state, 2);

    const vault = new MemoryVault();
    const processor = new MessageProcessor(
      () => settings,
      inbox,
      new VaultWriter(vault),
      new AttachmentService(vault),
      new ResultOutboxService(inbox, () => settings.connections),
    );
    await processor.processAvailableNow();

    expect(inbox.get(alert.key)).toMatchObject({ status: "complete", plan: { ruleId: "alerts" } });
    expect(inbox.get(state.key)).toMatchObject({ status: "complete", plan: { ruleId: "events" } });
    expect(vault.text.get("MQTT Sync/Alerts.md")).toContain("alarm");
    expect(vault.text.get("MQTT Sync/Events.md")).toContain("normal");
    expect(vault.text.get("MQTT Sync/Alerts.md")?.match(/mqtt-sync:v1/gu)).toHaveLength(1);
    expect(vault.text.get("MQTT Sync/Events.md")?.match(/mqtt-sync:v1/gu)).toHaveLength(1);
  });

  it("marks a publication ignored when no enabled rule matches and writes nothing", async () => {
    const settings = createDefaultSettings();
    settings.connections = [connection()];
    settings.rules.rules = [rule("alerts", "events/+/alert", "MQTT Sync/Alerts.md")];
    const store = new JsonStateStore(new MemoryStateAdapter(), "plugin");
    await store.load();
    const inbox = new DurableInboxService(store);
    const unmatched = message({ key: "unmatched", source: { topic: "devices/a/state" } });
    await inbox.accept(unmatched, 1);
    const vault = new MemoryVault();
    const processor = new MessageProcessor(
      () => settings,
      inbox,
      new VaultWriter(vault),
      new AttachmentService(vault),
      new ResultOutboxService(inbox, () => settings.connections),
    );

    await processor.processAvailableNow();

    expect(inbox.get(unmatched.key)?.status).toBe("ignored");
    expect(vault.text.size).toBe(0);
    expect(store.snapshot().outbox).toEqual({});
  });

  it("dead-letters a non-retryable planning failure and publishes a bounded failure result", async () => {
    const settings = createDefaultSettings();
    const configuredConnection = connection();
    configuredConnection.result = {
      topic: "results/processed",
      qos: 1,
      retain: false,
      privacy: "minimal",
    };
    settings.connections = [configuredConnection];
    settings.processing.maxAttempts = 1;
    settings.rules.rules = [rule("unsafe", "events/#", "../outside.md")];
    const store = new JsonStateStore(new MemoryStateAdapter(), "plugin");
    await store.load();
    const inbox = new DurableInboxService(store);
    const incoming = message({ key: "unsafe", source: { topic: "events/a" } });
    await inbox.accept(incoming, 1);
    const published: Array<Record<string, unknown>> = [];
    const vault = new MemoryVault();
    const processor = new MessageProcessor(
      () => settings,
      inbox,
      new VaultWriter(vault),
      new AttachmentService(vault),
      new ResultOutboxService(
        inbox,
        () => settings.connections,
        async (_config, _topic, payload) => {
          published.push(payload as unknown as Record<string, unknown>);
        },
      ),
    );

    await processor.processAvailableNow();

    expect(inbox.get(incoming.key)).toMatchObject({
      status: "dead_letter",
      resultStatus: "sent",
      lastError: { code: "PATH_INVALID", retryable: false },
    });
    expect(vault.text.size).toBe(0);
    expect(published).toEqual([
      expect.objectContaining({
        schema: "obsidian.mqtt-sync.result.v1",
        outcome: "failed",
        targetCount: 0,
        error: expect.objectContaining({ code: "PATH_INVALID", retryable: false }),
      }),
    ]);
  });
});
