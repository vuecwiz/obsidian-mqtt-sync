import { sha256Hex } from "../shared/crypto";
import { SyncError } from "../shared/errors";
import type { VaultPort } from "./vault-port";

export interface AttachmentReceipt {
  path: string;
  bytes: number;
  sha256: string;
}
export class AttachmentService {
  constructor(private readonly vault: VaultPort) {}
  async downloadAllowedOrigin(
    sourceUrl: string,
    allowedOrigin: string,
    targetPath: string,
    maxBytes: number,
    timeoutMs: number,
    expectedSha256?: string,
    signal?: AbortSignal,
  ): Promise<AttachmentReceipt> {
    let current = new URL(sourceUrl);
    if (
      current.protocol !== "https:" ||
      current.origin !== allowedOrigin ||
      current.username ||
      current.password
    )
      throw new SyncError("ATTACHMENT_POLICY", "Attachment origin is not allowed", false);
    const timeout = new AbortController();
    const timer = window.setTimeout(() => timeout.abort(), timeoutMs);
    signal?.addEventListener("abort", () => timeout.abort(), { once: true });
    let response: Response | undefined;
    try {
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        response = await window.fetch(current, { redirect: "manual", signal: timeout.signal });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location");
        if (!location) throw new SyncError("ATTACHMENT_POLICY", "Redirect has no location", false);
        const next = new URL(location, current);
        if (next.origin !== allowedOrigin || next.protocol !== "https:")
          throw new SyncError("ATTACHMENT_POLICY", "Cross-origin redirect blocked", false);
        current = next;
      }
      if (!response?.ok || !response.body)
        throw new SyncError("ATTACHMENT_HTTP", `Attachment HTTP ${response?.status ?? 0}`, true);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes)
        throw new SyncError("ATTACHMENT_TOO_LARGE", "Attachment exceeds configured limit", false);
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new SyncError(
            "ATTACHMENT_TOO_LARGE",
            "Attachment exceeded configured limit",
            false,
          );
        }
        chunks.push(value);
      }
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const digest = sha256Hex(combined);
      if (expectedSha256 && digest !== expectedSha256.toLowerCase())
        throw new SyncError("ATTACHMENT_DIGEST", "Attachment digest mismatch", false);
      const temporaryPath = `.mqtt-sync-staging/${sha256Hex(targetPath).slice(0, 24)}.part`;
      await this.vault.writeBinary(temporaryPath, combined.buffer);
      try {
        if (await this.vault.exists(targetPath)) {
          const existing = await this.vault.readBinary(targetPath);
          if (existing && sha256Hex(new Uint8Array(existing)) === digest)
            return { path: targetPath, bytes: total, sha256: digest };
          throw new SyncError("VAULT_CONFLICT", "Attachment target already exists", false);
        }
        await this.vault.rename(temporaryPath, targetPath);
      } finally {
        await this.vault.remove(temporaryPath);
      }
      return { path: targetPath, bytes: total, sha256: digest };
    } finally {
      window.clearTimeout(timer);
    }
  }
}
