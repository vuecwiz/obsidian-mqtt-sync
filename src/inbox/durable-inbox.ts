import type {
  EffectPlanV1,
  EffectReceiptV1,
  InboxRecordV1,
  IncomingMessage,
  OutboxRecordV1,
  SafeErrorV1,
  SourceKey,
} from "../domain/types";
import { retryDelayMs } from "../shared/backoff";
import { JsonStateStore } from "../state/store";

const RECOVERABLE = new Set(["accepted", "planned", "applying", "retry_wait", "committed"]);

export class DurableInboxService {
  constructor(private readonly store: JsonStateStore) {}

  async accept(message: IncomingMessage, now = Date.now()): Promise<"persisted" | "duplicate"> {
    let result: "persisted" | "duplicate" = "persisted";
    await this.store.mutate((state) => {
      const existing = state.records[message.key];
      if (existing) {
        existing.lastSeenAtMs = now;
        existing.updatedAtMs = now;
        state.telemetry.duplicates += 1;
        result = "duplicate";
        return;
      }
      state.records[message.key] = {
        schemaVersion: 1,
        message,
        status: "accepted",
        attempts: 0,
        resultStatus: "none",
        errorHistory: [],
        createdAtMs: now,
        updatedAtMs: now,
        lastSeenAtMs: now,
      };
    });
    return result;
  }

  async savePlan(key: SourceKey, plan: EffectPlanV1): Promise<void> {
    await this.store.mutate((state) => {
      const record = requiredRecord(state.records[key], key);
      record.plan = plan;
      record.status = "planned";
      record.updatedAtMs = Date.now();
    });
  }

  async markApplying(key: SourceKey): Promise<void> {
    await this.store.mutate((state) => {
      const record = requiredRecord(state.records[key], key);
      record.status = "applying";
      record.attempts += 1;
      record.updatedAtMs = Date.now();
    });
  }

  async markCommitted(key: SourceKey, receipt: EffectReceiptV1): Promise<void> {
    await this.store.mutate((state) => {
      const record = requiredRecord(state.records[key], key);
      record.receipt = receipt;
      record.status = "committed";
      record.updatedAtMs = Date.now();
    });
  }

  async markComplete(key: SourceKey): Promise<void> {
    await this.store.mutate((state) => {
      const record = requiredRecord(state.records[key], key);
      record.status = "complete";
      record.resultStatus = record.resultStatus === "pending" ? "pending" : "none";
      record.updatedAtMs = Date.now();
    });
  }

  async markIgnored(key: SourceKey): Promise<void> {
    await this.store.mutate((state) => {
      const record = requiredRecord(state.records[key], key);
      record.status = "ignored";
      record.updatedAtMs = Date.now();
    });
  }

  async markFailure(
    key: SourceKey,
    error: SafeErrorV1,
    maxAttempts: number,
    now = Date.now(),
  ): Promise<void> {
    await this.store.mutate((state) => {
      const record = requiredRecord(state.records[key], key);
      record.lastError = error;
      record.errorHistory.push(error);
      record.updatedAtMs = now;
      if (!error.retryable || record.attempts >= maxAttempts) {
        record.status = "dead_letter";
        delete record.nextAttemptAtMs;
      } else {
        record.status = "retry_wait";
        record.nextAttemptAtMs = now + retryDelayMs(record.attempts);
      }
    });
  }

  async retryDeadLetters(now = Date.now()): Promise<number> {
    let count = 0;
    await this.store.mutate((state) => {
      for (const record of Object.values(state.records)) {
        if (record.status === "dead_letter") {
          record.status = record.plan ? "planned" : "accepted";
          record.nextAttemptAtMs = now;
          record.updatedAtMs = now;
          count += 1;
        }
      }
    });
    return count;
  }

  claimable(now = Date.now()): InboxRecordV1[] {
    return Object.values(this.store.snapshot().records)
      .filter(
        (record) =>
          RECOVERABLE.has(record.status) &&
          (record.status !== "retry_wait" || (record.nextAttemptAtMs ?? 0) <= now),
      )
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  get(key: SourceKey): InboxRecordV1 | undefined {
    return this.store.snapshot().records[key];
  }

  async setWatermark(connectionId: string, topic: string, timeMs: number): Promise<void> {
    await this.store.mutate((state) => {
      const key = `${connectionId}/${encodeURIComponent(topic)}`;
      const old = state.topics[key]?.replayWatermarkMs ?? 0;
      state.topics[key] = { replayWatermarkMs: Math.max(old, timeMs) };
    });
  }

  watermark(connectionId: string, topics: string[]): number | undefined {
    const state = this.store.snapshot();
    const values = topics
      .map(
        (topic) => state.topics[`${connectionId}/${encodeURIComponent(topic)}`]?.replayWatermarkMs,
      )
      .filter((value): value is number => typeof value === "number" && value > 0);
    return values.length ? Math.min(...values) : undefined;
  }

  async countIgnoredEvent(event: string): Promise<void> {
    await this.store.mutate((state) => {
      state.telemetry.ignoredEvents[event] = (state.telemetry.ignoredEvents[event] ?? 0) + 1;
    });
  }

  async enqueueOutbox(record: OutboxRecordV1): Promise<void> {
    await this.store.mutate((state) => {
      state.outbox[record.sourceKey] ??= record;
      const inbox = state.records[record.sourceKey];
      if (inbox) inbox.resultStatus = "pending";
    });
  }

  async updateOutbox(key: SourceKey, update: Partial<OutboxRecordV1>): Promise<void> {
    await this.store.mutate((state) => {
      const outbox = state.outbox[key];
      if (outbox) Object.assign(outbox, update);
      const inbox = state.records[key];
      if (inbox && update.status === "sent") inbox.resultStatus = "sent";
      if (inbox && update.status === "failed") inbox.resultStatus = "failed";
    });
  }

  pendingOutbox(now = Date.now()): OutboxRecordV1[] {
    return Object.values(this.store.snapshot().outbox).filter(
      (record) => record.status === "pending" && record.nextAttemptAtMs <= now,
    );
  }

  async prune(retentionDays: number, retentionCount: number, now = Date.now()): Promise<number> {
    let removed = 0;
    await this.store.mutate((state) => {
      const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
      const completed = Object.values(state.records)
        .filter(
          (record) =>
            (record.status === "complete" || record.status === "ignored") &&
            record.resultStatus !== "pending" &&
            state.outbox[record.message.key]?.status !== "pending",
        )
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      const keep = new Set(
        completed
          .filter((record, index) => record.updatedAtMs >= cutoff && index < retentionCount)
          .map((record) => record.message.key),
      );
      for (const record of completed) {
        if (!keep.has(record.message.key)) {
          delete state.records[record.message.key];
          if (state.outbox[record.message.key]?.status === "sent") {
            delete state.outbox[record.message.key];
          }
          removed += 1;
        }
      }
    });
    return removed;
  }
}

function requiredRecord(record: InboxRecordV1 | undefined, key: string): InboxRecordV1 {
  if (!record) throw new Error(`Missing inbox record: ${key}`);
  return record;
}
