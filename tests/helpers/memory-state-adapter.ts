import type { StateStorageAdapter } from "../../src/state/store";

export class MemoryStateAdapter implements StateStorageAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  beforeWrite?: (path: string, content: string) => void | Promise<void>;
  beforeRename?: (from: string, to: string) => void | Promise<void>;
  beforeCopy?: (from: string, to: string) => void | Promise<void>;
  beforeRemove?: (path: string) => void | Promise<void>;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing file: ${path}`);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    await this.beforeWrite?.(path, content);
    this.files.set(path, content);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async copy(from: string, to: string): Promise<void> {
    await this.beforeCopy?.(from, to);
    if (this.files.has(to)) throw new Error(`Target exists: ${to}`);
    this.files.set(to, await this.read(from));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.beforeRename?.(from, to);
    if (this.files.has(to)) throw new Error(`Target exists: ${to}`);
    const content = await this.read(from);
    this.files.set(to, content);
    this.files.delete(from);
  }

  async remove(path: string): Promise<void> {
    await this.beforeRemove?.(path);
    this.files.delete(path);
  }
}

export function stateStoreFixture(directory = "plugin-state") {
  const adapter = new MemoryStateAdapter();
  return { adapter, directory };
}
