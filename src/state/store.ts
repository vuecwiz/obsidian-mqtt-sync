import type { DurableStateFileV1, DurableStatePayloadV1 } from "../domain/types";
import { sha256Hex } from "../shared/crypto";
import { SyncError } from "../shared/errors";

export interface StateStorageAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export function emptyState(now = Date.now()): DurableStatePayloadV1 {
  return {
    schemaVersion: 1,
    records: {},
    outbox: {},
    topics: {},
    telemetry: { ignoredEvents: {}, protocolErrors: 0, duplicates: 0 },
    updatedAtMs: now,
  };
}

export function stateChecksum(payload: DurableStatePayloadV1): string {
  return sha256Hex(JSON.stringify(payload));
}

export function encodeState(payload: DurableStatePayloadV1): string {
  const file: DurableStateFileV1 = {
    schemaVersion: 1,
    checksum: stateChecksum(payload),
    payload,
  };
  return JSON.stringify(file, null, 2);
}

export function decodeState(raw: string): DurableStatePayloadV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyncError("STATE_IO", "State file is not valid JSON", false);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyncError("STATE_IO", "State file is not an object", false);
  }
  const file = parsed as Partial<DurableStateFileV1>;
  if (file.schemaVersion !== 1 || !file.payload || typeof file.checksum !== "string") {
    throw new SyncError("STATE_IO", "Unsupported state schema", false);
  }
  if (file.payload.schemaVersion !== 1 || stateChecksum(file.payload) !== file.checksum) {
    throw new SyncError("STATE_IO", "State checksum mismatch", false);
  }
  return file.payload;
}

export class JsonStateStore {
  readonly primaryPath: string;
  readonly backupPath: string;
  readonly temporaryPath: string;
  private payload: DurableStatePayloadV1 = emptyState();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: StateStorageAdapter,
    private readonly pluginDirectory: string,
  ) {
    const prefix = pluginDirectory.replace(/\/+$/, "");
    this.primaryPath = `${prefix}/state-v1.json`;
    this.backupPath = `${prefix}/state-v1.backup.json`;
    this.temporaryPath = `${prefix}/state-v1.tmp.json`;
  }

  async load(): Promise<DurableStatePayloadV1> {
    if (!(await this.adapter.exists(this.pluginDirectory))) {
      await this.adapter.mkdir(this.pluginDirectory);
    }
    if (await this.adapter.exists(this.temporaryPath)) {
      await this.adapter.remove(this.temporaryPath);
    }
    if (!(await this.adapter.exists(this.primaryPath))) {
      if (await this.adapter.exists(this.backupPath)) {
        try {
          this.payload = decodeState(await this.adapter.read(this.backupPath));
          await this.persistNow();
          return this.payload;
        } catch {
          throw new SyncError("STATE_IO", "State backup is not recoverable", false);
        }
      }
      this.payload = emptyState();
      await this.persistNow();
      return this.payload;
    }
    try {
      this.payload = decodeState(await this.adapter.read(this.primaryPath));
      return this.payload;
    } catch (primaryError) {
      const corruptPath = `${this.primaryPath}.corrupt-${Date.now()}`;
      await this.adapter.rename(this.primaryPath, corruptPath);
      if (await this.adapter.exists(this.backupPath)) {
        try {
          this.payload = decodeState(await this.adapter.read(this.backupPath));
          await this.persistNow();
          return this.payload;
        } catch {
          // The primary error is more actionable and must not be hidden.
        }
      }
      throw primaryError;
    }
  }

  snapshot(): DurableStatePayloadV1 {
    return structuredClone(this.payload);
  }

  async mutate(mutator: (payload: DurableStatePayloadV1) => void): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      mutator(this.payload);
      this.payload.updatedAtMs = Date.now();
      await this.persistNow();
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async persistNow(): Promise<void> {
    try {
      await this.adapter.write(this.temporaryPath, encodeState(this.payload));
      if (await this.adapter.exists(this.primaryPath)) {
        if (await this.adapter.exists(this.backupPath)) {
          await this.adapter.remove(this.backupPath);
        }
        await this.adapter.copy(this.primaryPath, this.backupPath);
        await this.adapter.remove(this.primaryPath);
      }
      await this.adapter.rename(this.temporaryPath, this.primaryPath);
    } catch (error) {
      if (await this.adapter.exists(this.temporaryPath)) {
        await this.adapter.remove(this.temporaryPath).catch(() => undefined);
      }
      throw new SyncError(
        "STATE_IO",
        error instanceof Error ? error.message : "Unable to persist state",
        true,
      );
    }
  }
}
