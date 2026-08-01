import type { EffectPlanV1, EffectReceiptV1 } from "../domain/types";
import { SyncError } from "../shared/errors";
import type { VaultPort } from "./vault-port";

export function insertBlock(content: string, plan: EffectPlanV1): string {
  const block = plan.renderedBlock.trimEnd();
  if (plan.insertion.mode === "prepend") {
    return content ? `${block}\n\n${content}` : `${block}\n`;
  }
  if (plan.insertion.mode === "append") {
    return content ? `${content.trimEnd()}\n\n${block}\n` : `${block}\n`;
  }
  const heading = plan.insertion.heading?.trim();
  if (!heading) throw new SyncError("TEMPLATE_INVALID", "Missing insertion heading", false);
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex < 0) {
    const prefix = content.trimEnd();
    return `${prefix ? `${prefix}\n\n` : ""}${heading}\n\n${block}\n`;
  }
  const level = heading.match(/^#+/)?.[0].length ?? 6;
  let end = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const nextLevel = lines[index]?.match(/^(#+)\s/)?.[1]?.length;
    if (nextLevel !== undefined && nextLevel <= level) {
      end = index;
      break;
    }
  }
  const before = lines.slice(0, end).join("\n").trimEnd();
  const after = lines.slice(end).join("\n").replace(/^\n+/, "");
  return `${before}\n\n${block}\n${after ? `\n${after}` : ""}`;
}

export class VaultWriter {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly vault: VaultPort) {}

  inspect(plan: EffectPlanV1): Promise<boolean> {
    return this.vault
      .readText(plan.notePath)
      .then((content) => content?.includes(plan.marker) ?? false);
  }

  execute(
    plan: EffectPlanV1,
    attachment?: { path: string; bytes: number; sha256: string },
  ): Promise<EffectReceiptV1> {
    return this.lock(plan.notePath, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const original = (await this.vault.readText(plan.notePath)) ?? "";
        if (original.includes(plan.marker)) {
          return {
            notePath: plan.notePath,
            markerFound: true,
            alreadyApplied: true,
            attachmentPath: attachment?.path,
            attachmentBytes: attachment?.bytes,
            attachmentSha256: attachment?.sha256,
            committedAtMs: Date.now(),
          };
        }
        const updated = insertBlock(original, plan);
        const observed = (await this.vault.readText(plan.notePath)) ?? "";
        if (observed !== original) continue;
        await this.vault.writeText(plan.notePath, updated);
        const verified = await this.vault.readText(plan.notePath);
        if (verified?.includes(plan.marker)) {
          return {
            notePath: plan.notePath,
            markerFound: true,
            alreadyApplied: false,
            attachmentPath: attachment?.path,
            attachmentBytes: attachment?.bytes,
            attachmentSha256: attachment?.sha256,
            committedAtMs: Date.now(),
          };
        }
      }
      throw new SyncError("VAULT_CONFLICT", "Vault changed during write", true);
    });
  }

  private async lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
