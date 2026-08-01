import type { IncomingMessage } from "../domain/types";
import { SyncError } from "../shared/errors";

const TOKEN_PATTERN = /{{\s*([^{}]+?)\s*}}/g;
const ALLOWED_DATE_FORMAT = /^[YMDHhmsS:\-_/ .]+$/;

export interface RenderContext {
  message: IncomingMessage;
  file?: { path: string; link: string; embed: string };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function formatUtcDate(timestampMs: number, format: string): string {
  if (!ALLOWED_DATE_FORMAT.test(format)) {
    throw new SyncError("TEMPLATE_INVALID", "Unsupported date format", false);
  }
  const date = new Date(timestampMs);
  const values: Record<string, string> = {
    YYYY: String(date.getUTCFullYear()),
    MM: pad(date.getUTCMonth() + 1),
    DD: pad(date.getUTCDate()),
    HH: pad(date.getUTCHours()),
    hh: pad(((date.getUTCHours() + 11) % 12) + 1),
    mm: pad(date.getUTCMinutes()),
    ss: pad(date.getUTCSeconds()),
    SSS: pad(date.getUTCMilliseconds(), 3),
  };
  return format.replace(/YYYY|SSS|MM|DD|HH|hh|mm|ss/g, (token) => values[token]!);
}

export function listTemplateTokens(template: string): string[] {
  return [...template.matchAll(TOKEN_PATTERN)].map((match) => match[1]!.trim());
}

function renderToken(token: string, context: RenderContext, pathMode: boolean): string {
  const { message } = context;
  if (token === "content") return message.body;
  if (token === "payload") return message.body;
  const contentLength = token.match(/^content:(\d+)$/);
  if (contentLength) return message.body.slice(0, Number(contentLength[1]));
  if (token === "title") return message.title;
  if (token === "topic") return message.source.topic;
  if (token === "messageId") return message.source.messageId;
  if (token === "qos") return String(message.delivery.qos);
  if (token === "retain") return String(message.delivery.retain);
  if (token === "contentType") return message.contentType ?? "";
  if (token === "responseTopic") return message.responseTopic ?? "";
  if (token === "correlationData") return message.correlationData ?? "";
  const property = token.match(/^userProperty:(.+)$/);
  if (property) return message.userProperties[property[1]!]?.join(", ") ?? "";
  if (token === "priority") return String(message.priority);
  if (token === "tags") return message.tags.join(", ");
  const tag = token.match(/^tag:\[(\d+)]$/);
  if (tag) return message.tags[Number(tag[1]!)] ?? "";
  if (token === "url1") return message.firstUrl?.raw ?? "";
  if (token === "url1:host") return message.firstUrl?.hostname ?? "";
  if (token === "attachment:name") return message.attachment?.name ?? "";
  if (token === "attachment:type") return message.attachment?.type ?? "";
  if (token === "file:path") return context.file?.path ?? "";
  if (token === "file:link") return context.file?.link ?? "";
  if (token === "file:embed") return context.file?.embed ?? "";
  const date = token.match(/^(messageDate|messageTime|receivedDate):(.+)$/);
  if (date) {
    const timestamp = date[1] === "receivedDate" ? message.receivedAtMs : message.publishedAtMs;
    return formatUtcDate(timestamp, date[2]!);
  }
  throw new SyncError(
    "TEMPLATE_INVALID",
    `Unknown template variable: ${pathMode ? "<path-token>" : token}`,
    false,
  );
}

export function renderTemplate(template: string, context: RenderContext, pathMode = false): string {
  return template.replace(TOKEN_PATTERN, (_full, rawToken: string) =>
    renderToken(rawToken.trim(), context, pathMode),
  );
}

export function validateTemplate(template: string, pathMode = false): string[] {
  const issues: string[] = [];
  const fake: IncomingMessage = {
    schemaVersion: 1,
    key: "fake",
    source: {
      connectionId: "fake",
      brokerHash: "broker",
      topic: "topic",
      messageId: "id",
      protocolVersion: 5,
      matchingFilters: ["#"],
    },
    publishedAtMs: 0,
    receivedAtMs: 0,
    title: "",
    body: "",
    priority: 3,
    tags: [],
    identityKind: "envelope-id",
    delivery: { qos: 1, retain: false, duplicate: false },
    payload: { byteLength: 0, sha256: "" },
    userProperties: {},
    unknownFields: [],
  };
  for (const token of listTemplateTokens(template)) {
    try {
      renderToken(token, { message: fake }, pathMode);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "Invalid token");
    }
  }
  return issues;
}
