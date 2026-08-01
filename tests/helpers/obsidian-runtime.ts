export class TFile {
  path = "";
}

export abstract class AbstractInputSuggest<T> {
  limit = 0;

  constructor(_app: unknown, _inputEl: unknown) {}

  abstract renderSuggestion(value: T, el: unknown): void;

  abstract selectSuggestion(value: T): void;

  close(): void {}
}

export class Modal {
  constructor(_app: unknown) {}

  open(): void {}

  close(): void {}
}

export class Notice {
  constructor(_message: string) {}
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl = {
    addClass: () => undefined,
    dataset: {},
    empty: () => undefined,
  };

  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }

  display(): void {}

  update(): void {}
}

export class Setting {}

export function normalizePath(path: string): string {
  return path
    .replaceAll("\\\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

export async function requestUrl(
  request:
    | string
    | {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string | ArrayBuffer;
        throw?: boolean;
      },
): Promise<{
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}> {
  const options = typeof request === "string" ? { url: request } : request;
  const response = await fetch(options.url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
  if (options.throw !== false && response.status >= 400) {
    throw new Error(`HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: response.status,
    headers,
    arrayBuffer,
    json,
    text,
  };
}
