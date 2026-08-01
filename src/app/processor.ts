import type {
  ConnectionConfigV1,
  InboxRecordV1,
  PersistedSettingsV1,
  ResultPayloadV1,
} from "../domain/types";
import { AttachmentService } from "../effects/attachment";
import { planEffect } from "../effects/planner";
import { VaultWriter } from "../effects/vault-writer";
import { DurableInboxService } from "../inbox/durable-inbox";
import { matchRule } from "../rules/engine";
import { toSafeError } from "../shared/errors";
import { ResultOutboxService } from "./result-outbox";

export class MessageProcessor {
  private readonly active = new Set<string>();
  private timer?: number;
  private stopped = true;

  constructor(
    private readonly settings: () => PersistedSettingsV1,
    private readonly inbox: DurableInboxService,
    private readonly writer: VaultWriter,
    private readonly attachments: AttachmentService,
    private readonly outbox: ResultOutboxService,
  ) {}

  start(): void {
    this.stopped = false;
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  wake(delayMs = 0): void {
    if (this.stopped || this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    await this.processAvailableNow();
    if (this.inbox.claimable().length || this.inbox.pendingOutbox().length) this.wake(250);
    else this.wake(5_000);
  }

  async processAvailableNow(): Promise<void> {
    const limit = Math.max(1, this.settings().processing.concurrency);
    const candidates = this.inbox
      .claimable()
      .filter((record) => !this.active.has(record.message.key))
      .slice(0, Math.max(0, limit - this.active.size));
    await Promise.all(candidates.map((record) => this.processRecord(record)));
    await this.outbox.drain();
  }

  private async processRecord(record: InboxRecordV1): Promise<void> {
    const key = record.message.key;
    this.active.add(key);
    try {
      const settings = this.settings();
      let plan = record.plan;
      if (!plan) {
        const match = matchRule(record.message, settings.rules);
        if (match.kind === "none") {
          await this.inbox.markIgnored(key);
          return;
        }
        plan = planEffect(record.message, match.rule, settings.templates, settings.processing);
        await this.inbox.savePlan(key, plan);
      }
      if (record.status === "applying" && (await this.writer.inspect(plan))) {
        await this.inbox.markCommitted(key, {
          notePath: plan.notePath,
          markerFound: true,
          alreadyApplied: true,
          committedAtMs: Date.now(),
        });
      } else if (record.status !== "committed") {
        await this.inbox.markApplying(key);
        const attachment =
          plan.attachment?.mode === "download" && plan.attachment.targetPath
            ? await this.attachments.downloadAllowedOrigin(
                plan.attachment.sourceUrl,
                new URL(plan.attachment.sourceUrl).origin,
                plan.attachment.targetPath,
                plan.attachment.expectedMaxBytes,
                settings.processing.attachmentTimeoutMs,
                plan.attachment.expectedSha256,
              )
            : undefined;
        const receipt = await this.writer.execute(plan, attachment);
        await this.inbox.markCommitted(key, receipt);
      }
      const current = this.inbox.get(key);
      const connection = connectionFor(settings.connections, record.message.source.connectionId);
      const payload = resultPayload(
        current ?? record,
        "succeeded",
        connection.result?.privacy === "paths",
      );
      const queued = await this.outbox.enqueue(key, record.message.source.connectionId, payload);
      await this.inbox.markComplete(key);
      if (queued) await this.outbox.drain();
    } catch (error) {
      const safeError = toSafeError(error);
      await this.inbox.markFailure(key, safeError, this.settings().processing.maxAttempts);
      const failed = this.inbox.get(key);
      if (failed?.status === "dead_letter") {
        const connection = connectionFor(
          this.settings().connections,
          failed.message.source.connectionId,
        );
        await this.outbox.enqueue(
          key,
          failed.message.source.connectionId,
          failureResultPayload(
            failed,
            safeError.code,
            safeError.retryable,
            connection.result?.privacy === "paths",
          ),
        );
        await this.outbox.drain();
      }
    } finally {
      this.active.delete(key);
    }
  }
}

function failureResultPayload(
  record: InboxRecordV1,
  code: string,
  retryable: boolean,
  includePaths: boolean,
): ResultPayloadV1 {
  return {
    ...resultPayload(record, "failed", includePaths),
    error: { code, retryable, attempt: record.attempts },
  };
}

function connectionFor(connections: ConnectionConfigV1[], id: string): ConnectionConfigV1 {
  const connection = connections.find((item) => item.id === id);
  if (!connection) throw new Error("Connection no longer exists");
  return connection;
}

function resultPayload(
  record: InboxRecordV1,
  outcome: ResultPayloadV1["outcome"],
  includePaths: boolean,
): ResultPayloadV1 {
  return {
    schema: "obsidian.mqtt-sync.result.v1",
    correlation: {
      topic: record.message.source.topic,
      messageId: record.message.source.messageId,
    },
    outcome,
    processedAt: new Date().toISOString(),
    targetCount: record.receipt ? 1 : 0,
    targets: includePaths && record.receipt ? [record.receipt.notePath] : undefined,
  };
}
