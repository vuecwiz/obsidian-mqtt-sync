export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000] as const;

export function retryDelayMs(attempt: number): number {
  if (attempt > RETRY_DELAYS_MS.length) return 6 * 60 * 60 * 1000;
  return RETRY_DELAYS_MS[Math.max(attempt - 1, 0)] ?? RETRY_DELAYS_MS[0];
}

export function fullJitterBackoff(
  attempt: number,
  minMs: number,
  maxMs: number,
  random = Math.random,
): number {
  const cap = Math.min(maxMs, minMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * cap);
}
