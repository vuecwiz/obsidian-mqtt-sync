import { normalizePath, TFile, type App } from "obsidian";

export interface VaultPort {
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, content: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer | undefined>;
  writeBinary(path: string, content: ArrayBuffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

export class ObsidianVaultPort implements VaultPort {
  constructor(private readonly app: App) {}

  async readText(path: string): Promise<string | undefined> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return file instanceof TFile ? this.app.vault.read(file) : undefined;
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.ensureParent(path);
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file instanceof TFile) await this.app.vault.modify(file, content);
    else if (file) throw new Error(`Vault path is not a file: ${normalizePath(path)}`);
    else await this.app.vault.create(normalizePath(path), content);
  }

  async readBinary(path: string): Promise<ArrayBuffer | undefined> {
    if (!(await this.exists(path))) return undefined;
    return this.app.vault.adapter.readBinary(normalizePath(path));
  }

  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    await this.ensureParent(path);
    await this.app.vault.adapter.writeBinary(normalizePath(path), content);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.ensureParent(to);
    await this.app.vault.adapter.rename(normalizePath(from), normalizePath(to));
  }

  async remove(path: string): Promise<void> {
    if (await this.exists(path)) await this.app.vault.adapter.remove(normalizePath(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(normalizePath(path));
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized && !(await this.exists(normalized))) {
      await this.app.vault.adapter.mkdir(normalized);
    }
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = normalizePath(path).split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      await this.mkdir(current);
    }
  }
}
