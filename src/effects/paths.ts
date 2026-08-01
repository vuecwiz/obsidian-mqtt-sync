import { normalize } from "node:path/posix";
import { SyncError } from "../shared/errors";

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const INVALID_COMPONENT = /[<>:"|?*]/g;

export function sanitizePathComponent(value: string, maxLength = 120): string {
  const withoutControls = [...value]
    .map((character) => (character.codePointAt(0)! < 32 ? "_" : character))
    .join("");
  const cleaned = withoutControls
    .normalize("NFC")
    .replace(INVALID_COMPONENT, "_")
    .replace(/[\\/]+/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return (cleaned || "untitled").slice(0, maxLength);
}

export function normalizeVaultPath(
  raw: string,
  options: { requireMarkdown?: boolean; maxLength?: number } = {},
): string {
  const replaced = raw.replace(/\\/g, "/").normalize("NFC");
  if (
    !replaced ||
    replaced.startsWith("/") ||
    replaced.startsWith("~") ||
    WINDOWS_DRIVE.test(raw) ||
    replaced.includes("\0")
  ) {
    throw new SyncError("PATH_INVALID", "Path must be Vault-relative", false);
  }
  const rawParts = replaced.split("/");
  if (rawParts.some((part) => part === ".." || part === "." || !part)) {
    throw new SyncError("PATH_INVALID", "Path traversal or empty component is not allowed", false);
  }
  const cleaned = rawParts.map((part) => sanitizePathComponent(part)).join("/");
  const normalized = normalize(cleaned);
  if (normalized.startsWith("../") || normalized === "..") {
    throw new SyncError("PATH_INVALID", "Path escapes Vault", false);
  }
  if (normalized.length > (options.maxLength ?? 512)) {
    throw new SyncError("PATH_INVALID", "Path exceeds configured length", false);
  }
  if (options.requireMarkdown && !normalized.toLowerCase().endsWith(".md")) {
    throw new SyncError("PATH_INVALID", "Note path must end in .md", false);
  }
  return normalized;
}
