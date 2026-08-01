import type { SafeErrorV1 } from "../domain/types";

export class SyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export function toSafeError(error: unknown, now = Date.now()): SafeErrorV1 {
  if (error instanceof SyncError) {
    return { code: error.code, message: error.message, retryable: error.retryable, atMs: now };
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return { code: "UNKNOWN_RETRYABLE", message, retryable: true, atMs: now };
}
