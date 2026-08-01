import type { VaultPort } from "../../src/effects/vault-port";

export class MemoryVault implements VaultPort {
  readonly text = new Map<string, string>();
  readonly binary = new Map<string, ArrayBuffer>();
  readonly directories = new Set<string>();
  beforeWrite?: (path: string) => void | Promise<void>;

  async readText(path: string): Promise<string | undefined> {
    return this.text.get(path);
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.beforeWrite?.(path);
    this.text.set(path, content);
  }

  async readBinary(path: string): Promise<ArrayBuffer | undefined> {
    return this.binary.get(path);
  }

  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.binary.set(path, content.slice(0));
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.binary.get(from);
    if (value) {
      this.binary.set(to, value);
      this.binary.delete(from);
    }
  }

  async remove(path: string): Promise<void> {
    this.text.delete(path);
    this.binary.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.text.has(path) || this.binary.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }
}
