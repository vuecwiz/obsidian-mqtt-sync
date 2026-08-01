import type { ConnectionConfigV1, ResultPayloadV1, SourceKey } from "../domain/types";
import { retryDelayMs } from "../shared/backoff";
import { toSafeError } from "../shared/errors";
import { DurableInboxService } from "../inbox/durable-inbox";
import { mqttPublish } from "../transport/mqtt/connection";

export class ResultOutboxService {
  constructor(
    private readonly inbox: DurableInboxService,
    private readonly connections: () => ConnectionConfigV1[],
    private readonly publish: typeof mqttPublish = mqttPublish,
  ) {}
  async enqueue(
    sourceKey: SourceKey,
    connectionId: string,
    payload: ResultPayloadV1,
  ): Promise<boolean> {
    if (!this.connections().find((item) => item.id === connectionId)?.result?.topic) return false;
    await this.inbox.enqueueOutbox({
      sourceKey,
      connectionId,
      payload,
      attempts: 0,
      nextAttemptAtMs: Date.now(),
      status: "pending",
    });
    return true;
  }
  async drain(signal?: AbortSignal): Promise<void> {
    for (const record of this.inbox.pendingOutbox()) {
      const connection = this.connections().find((item) => item.id === record.connectionId);
      if (!connection?.result) {
        await this.inbox.updateOutbox(record.sourceKey, { status: "failed" });
        continue;
      }
      try {
        await this.publish(
          connection,
          connection.result.topic,
          record.payload,
          connection.result.qos,
          connection.result.retain,
          signal,
        );
        await this.inbox.updateOutbox(record.sourceKey, { status: "sent" });
      } catch (error) {
        const attempts = record.attempts + 1;
        await this.inbox.updateOutbox(record.sourceKey, {
          attempts,
          nextAttemptAtMs: Date.now() + retryDelayMs(attempts),
          lastError: toSafeError(error),
          status: attempts >= 8 ? "failed" : "pending",
        });
      }
    }
  }
}
