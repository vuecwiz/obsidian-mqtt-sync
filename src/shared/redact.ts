const SECRET_KEYS = /authorization|password|token|secret|credential|cookie/i;

export function redactText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)(basic|bearer)\s+[^\s,;]+/gi, "$1$2 <redacted>")
    .replace(/([?&](?:auth|token|access_token|password)=)[^&#\s]+/gi, "$1<redacted>")
    .replace(/\bhttps?:\/\/[^\s]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}${url.search ? "?<redacted>" : ""}`;
      } catch {
        return "<redacted-url>";
      }
    });
}

export function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactObject);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactText(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEYS.test(key) ? "<redacted>" : redactObject(entry),
    ]),
  );
}
