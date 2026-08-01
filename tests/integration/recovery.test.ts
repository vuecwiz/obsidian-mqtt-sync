import { DurableInboxService } from "../../src/inbox/durable-inbox";
import { JsonStateStore } from "../../src/state/store";
import { VaultWriter } from "../../src/effects/vault-writer";
import { MemoryVault } from "../helpers/memory-vault";
import { MemoryStateAdapter } from "../helpers/memory-state-adapter";
import { message } from "../helpers/message";
import { createDefaultSettings } from "../../src/settings/defaults";
import { planEffect } from "../../src/effects/planner";
import { AttachmentService } from "../../src/effects/attachment";
import { ResultOutboxService } from "../../src/app/result-outbox";
import { MessageProcessor } from "../../src/app/processor";
import type { ConnectionConfigV1 } from "../../src/domain/types";

describe("durable effective-once recovery", () => {
  it("persists before processing, dedupes replay, and inspects the Vault marker", async () => {
    const adapter = new MemoryStateAdapter();
    const store = new JsonStateStore(adapter, "plugin");
    await store.load();
    const inbox = new DurableInboxService(store);
    const incoming = message();
    expect(await inbox.accept(incoming, 1)).toBe("persisted");
    expect(
      await inbox.accept(
        { ...incoming, delivery: { ...incoming.delivery, duplicate: true, packetId: 77 } },
        2,
      ),
    ).toBe("duplicate");
    const plan = {
      schemaVersion: 1 as const,
      sourceKey: incoming.key,
      ruleId: "inbox",
      ruleRevision: 1,
      notePath: "MQTT Sync/Inbox.md",
      marker: "<!-- mqtt-sync:v1 key=x rule=inbox@1 -->",
      renderedBlock: "<!-- mqtt-sync:v1 key=x rule=inbox@1 -->\nhello",
      insertion: { mode: "append" as const },
    };
    await inbox.savePlan(incoming.key, plan);
    await inbox.markApplying(incoming.key);
    const vault = new MemoryVault();
    const writer = new VaultWriter(vault);
    await writer.execute(plan);
    expect(await writer.inspect(plan)).toBe(true);
    expect((await writer.execute(plan)).alreadyApplied).toBe(true);
    expect(vault.text.get(plan.notePath)?.match(/mqtt-sync:v1/gu)).toHaveLength(1);
  });
  it("recovers a corrupt primary from the checksum-protected backup", async () => {
    const adapter = new MemoryStateAdapter();
    const first = new JsonStateStore(adapter, "plugin");
    await first.load();
    await first.mutate((state) => {
      state.telemetry.duplicates = 7;
    });
    adapter.files.set(first.primaryPath, "corrupt");
    const recovered = new JsonStateStore(adapter, "plugin");
    await recovered.load();
    expect(recovered.snapshot().telemetry.duplicates).toBe(0);
    expect([...adapter.files.keys()].some((path) => path.includes(".corrupt-"))).toBe(true);
  });

  it.each(["accepted", "planned", "applying-before-write", "applying-after-write", "committed"])(
    "converges from the %s crash window to one Vault marker",
    async (window) => {
      const adapter = new MemoryStateAdapter();
      const store = new JsonStateStore(adapter, "plugin");
      await store.load();
      const inbox = new DurableInboxService(store);
      const incoming = message();
      const settings = processingSettings();
      const plan = planEffect(
        incoming,
        settings.rules.rules[0]!,
        settings.templates,
        settings.processing,
      );
      const vault = new MemoryVault();
      const writer = new VaultWriter(vault);
      await inbox.accept(incoming, 1);
      if (window !== "accepted") await inbox.savePlan(incoming.key, plan);
      if (window === "applying-before-write" || window === "applying-after-write") {
        await inbox.markApplying(incoming.key);
      }
      let receipt;
      if (window === "applying-after-write" || window === "committed") {
        receipt = await writer.execute(plan);
      }
      if (window === "committed") await inbox.markCommitted(incoming.key, receipt!);

      const restartedStore = new JsonStateStore(adapter, "plugin");
      await restartedStore.load();
      const restartedInbox = new DurableInboxService(restartedStore);
      const processor = new MessageProcessor(
        () => settings,
        restartedInbox,
        new VaultWriter(vault),
        new AttachmentService(vault),
        new ResultOutboxService(restartedInbox, () => settings.connections),
      );
      await processor.processAvailableNow();

      expect(restartedInbox.get(incoming.key)?.status).toBe("complete");
      expect(vault.text.get(plan.notePath)?.match(/mqtt-sync:v1/gu)).toHaveLength(1);
    },
  );

  it("restarts a pending result outbox and completes the side effect at most once", async () => {
    const adapter = new MemoryStateAdapter();
    const store = new JsonStateStore(adapter, "plugin");
    await store.load();
    const inbox = new DurableInboxService(store);
    const incoming = message();
    const settings = processingSettings(true);
    const plan = planEffect(
      incoming,
      settings.rules.rules[0]!,
      settings.templates,
      settings.processing,
    );
    const vault = new MemoryVault();
    const receipt = await new VaultWriter(vault).execute(plan);
    await inbox.accept(incoming, 1);
    await inbox.savePlan(incoming.key, plan);
    await inbox.markApplying(incoming.key);
    await inbox.markCommitted(incoming.key, receipt);
    await inbox.enqueueOutbox({
      sourceKey: incoming.key,
      connectionId: "primary",
      payload: {
        schema: "obsidian.mqtt-sync.result.v1",
        correlation: { topic: incoming.source.topic, messageId: incoming.source.messageId },
        outcome: "succeeded",
        processedAt: new Date(0).toISOString(),
        targetCount: 1,
      },
      attempts: 0,
      nextAttemptAtMs: 0,
      status: "pending",
    });
    await inbox.markComplete(incoming.key);

    const restartedStore = new JsonStateStore(adapter, "plugin");
    await restartedStore.load();
    const restartedInbox = new DurableInboxService(restartedStore);
    let publishes = 0;
    const outbox = new ResultOutboxService(
      restartedInbox,
      () => settings.connections,
      async () => {
        publishes += 1;
      },
    );
    await outbox.drain();
    await outbox.drain();
    expect(publishes).toBe(1);
    expect(restartedStore.snapshot().outbox[incoming.key]?.status).toBe("sent");
    expect(vault.text.get(plan.notePath)?.match(/mqtt-sync:v1/gu)).toHaveLength(1);
  });

  it("fails closed for corrupt-both and recovers interrupted replacement state", async () => {
    const corruptAdapter = new MemoryStateAdapter();
    const corruptStore = new JsonStateStore(corruptAdapter, "plugin");
    await corruptStore.load();
    await corruptStore.mutate((state) => {
      state.telemetry.duplicates = 1;
    });
    corruptAdapter.files.set(corruptStore.primaryPath, "corrupt-primary");
    corruptAdapter.files.set(corruptStore.backupPath, "corrupt-backup");
    await expect(new JsonStateStore(corruptAdapter, "plugin").load()).rejects.toThrow(/State/u);

    const partialAdapter = new MemoryStateAdapter();
    const partialStore = new JsonStateStore(partialAdapter, "plugin");
    await partialStore.load();
    await partialStore.mutate((state) => {
      state.telemetry.duplicates = 2;
    });
    partialAdapter.files.delete(partialStore.primaryPath);
    partialAdapter.files.set(partialStore.temporaryPath, "partial replacement");
    const recovered = new JsonStateStore(partialAdapter, "plugin");
    await recovered.load();
    expect(partialAdapter.files.has(partialStore.temporaryPath)).toBe(false);
    expect(recovered.snapshot().telemetry.duplicates).toBe(0);
  });

  it("preserves the old primary on interrupted backup creation and never prunes unresolved work", async () => {
    const adapter = new MemoryStateAdapter();
    const store = new JsonStateStore(adapter, "plugin");
    await store.load();
    const originalPrimary = adapter.files.get(store.primaryPath);
    adapter.beforeCopy = () => {
      throw new Error("injected backup interruption");
    };
    await expect(
      store.mutate((state) => {
        state.telemetry.duplicates = 9;
      }),
    ).rejects.toThrow(/backup interruption/u);
    expect(adapter.files.get(store.primaryPath)).toBe(originalPrimary);
    expect(adapter.files.has(store.temporaryPath)).toBe(false);
    adapter.beforeCopy = undefined;

    const restartedStore = new JsonStateStore(adapter, "plugin");
    await restartedStore.load();
    const inbox = new DurableInboxService(restartedStore);
    const pending = message({ key: "pending", source: { messageId: "pending" } });
    const dead = message({ key: "dead", source: { messageId: "dead" } });
    const complete = message({ key: "complete", source: { messageId: "complete" } });
    await inbox.accept(pending, 1);
    await inbox.accept(dead, 1);
    await inbox.markFailure(
      dead.key,
      { code: "FIXTURE", message: "fixture", retryable: false, atMs: 1 },
      1,
    );
    await inbox.accept(complete, 1);
    await inbox.markComplete(complete.key);
    await inbox.enqueueOutbox({
      sourceKey: pending.key,
      connectionId: "primary",
      payload: {
        schema: "obsidian.mqtt-sync.result.v1",
        correlation: { topic: pending.source.topic, messageId: pending.source.messageId },
        outcome: "succeeded",
        processedAt: new Date(0).toISOString(),
        targetCount: 0,
      },
      attempts: 0,
      nextAttemptAtMs: 0,
      status: "pending",
    });
    await inbox.prune(0, 0, Date.now() + 1);
    expect(inbox.get(pending.key)).toBeDefined();
    expect(inbox.get(dead.key)?.status).toBe("dead_letter");
    expect(inbox.get(complete.key)).toBeUndefined();
    expect(restartedStore.snapshot().outbox[pending.key]?.status).toBe("pending");
  });
});

function processingSettings(withResult = false) {
  const settings = createDefaultSettings();
  const connection: ConnectionConfigV1 = {
    id: "primary",
    name: "Fixture",
    brokerUrl: "mqtt://127.0.0.1:1883",
    protocolVersion: 5,
    clientId: "fixture-client",
    auth: {},
    tls: {},
    allowInsecureRemote: false,
    keepAliveSeconds: 60,
    connectTimeoutMs: 30_000,
    cleanStart: true,
    sessionExpirySeconds: 0,
    subscriptions: [
      {
        filter: "test/#",
        qos: 1,
        noLocal: true,
        retainAsPublished: true,
        retainHandling: 1,
        enabled: true,
      },
    ],
    reconnect: { minMs: 100, maxMs: 1_000, jitterRatio: 1 },
    useCorrelationDataAsId: false,
    result: withResult
      ? { topic: "test/result", qos: 1, retain: false, privacy: "minimal" }
      : undefined,
  };
  settings.connections = [connection];
  return settings;
}
