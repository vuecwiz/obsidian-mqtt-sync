import type { ConditionV1, RuleV1 } from "../domain/types";
import {
  conditionFieldLabel,
  conditionOperatorLabel,
  createI18n,
  mimePresetLabel,
  summarizeRuleLocalized,
  type I18n,
} from "../i18n";

const EN_I18N = createI18n("en", "en");

export const CONDITION_FIELDS = [
  "topic",
  "title",
  "body",
  "tag",
  "priority",
  "qos",
  "retain",
  "duplicate",
  "contentType",
  "responseTopic",
  "hasCorrelationData",
  "hasAttachment",
  "hasHttpUrl",
  "attachmentMime",
  "firstUrlHost",
] as const satisfies readonly ConditionV1["field"][];

export type ConditionField = (typeof CONDITION_FIELDS)[number];

export interface MimeTypePreset {
  value: string;
  label: string;
}

export const MIME_TYPE_PRESETS = [
  { value: "image/jpeg", label: "JPEG image" },
  { value: "image/png", label: "PNG image" },
  { value: "image/gif", label: "GIF image" },
  { value: "image/webp", label: "WebP image" },
  { value: "image/svg+xml", label: "SVG image" },
  { value: "image/heic", label: "HEIC image" },
  { value: "application/pdf", label: "PDF document" },
  { value: "text/plain", label: "Plain text" },
  { value: "text/markdown", label: "Markdown text" },
  { value: "text/html", label: "HTML document" },
  { value: "application/json", label: "JSON data" },
  { value: "application/zip", label: "ZIP archive" },
  { value: "application/gzip", label: "Gzip archive" },
  { value: "audio/mpeg", label: "MP3 audio" },
  { value: "audio/ogg", label: "Ogg audio" },
  { value: "audio/wav", label: "WAV audio" },
  { value: "video/mp4", label: "MP4 video" },
  { value: "video/webm", label: "WebM video" },
  { value: "application/octet-stream", label: "Generic binary" },
] as const satisfies readonly MimeTypePreset[];

export const MIME_FAMILY_PRESETS = [
  { value: "image/", label: "Any image" },
  { value: "audio/", label: "Any audio" },
  { value: "video/", label: "Any video" },
  { value: "text/", label: "Any text" },
  { value: "application/", label: "Any application type" },
] as const satisfies readonly MimeTypePreset[];

export function mimeTypePresets(
  operator: "equals" | "startsWith",
  query = "",
  i18n: I18n = EN_I18N,
): readonly MimeTypePreset[] {
  const source = (
    operator === "startsWith" ? [...MIME_FAMILY_PRESETS, ...MIME_TYPE_PRESETS] : MIME_TYPE_PRESETS
  ).map((preset) => ({ ...preset, label: mimePresetLabel(i18n, preset.value, preset.label) }));
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return source;
  return source.filter((preset) => {
    const searchable = `${preset.label} ${preset.value}`.toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

export const CONDITION_FIELD_LABELS: Record<ConditionField, string> = {
  topic: "Topic",
  title: "Title",
  body: "Message body",
  tag: "Has tag",
  priority: "Priority",
  qos: "QoS",
  retain: "Retained message",
  duplicate: "Duplicate delivery flag",
  contentType: "Content type",
  responseTopic: "Response topic",
  hasCorrelationData: "Has correlation data",
  hasAttachment: "Has attachment",
  hasHttpUrl: "Has HTTP URL",
  attachmentMime: "Attachment MIME type",
  firstUrlHost: "First URL host",
};

export const CONDITION_OPERATOR_LABELS: Record<string, string> = {
  equals: "equals",
  contains: "contains",
  startsWith: "starts with",
  gte: "is at least",
  hostEquals: "host equals",
  hostOrSubdomainOf: "host or subdomain of",
};

export function operatorsForField(field: ConditionField): string[] {
  switch (field) {
    case "title":
    case "body":
    case "contentType":
    case "responseTopic":
      return ["equals", "contains", "startsWith"];
    case "topic":
      return ["equals", "contains", "startsWith", "matchesFilter"];
    case "tag":
      return ["contains"];
    case "priority":
    case "qos":
      return ["equals", "gte"];
    case "hasAttachment":
    case "hasHttpUrl":
    case "retain":
    case "duplicate":
    case "hasCorrelationData":
      return ["equals"];
    case "attachmentMime":
      return ["equals", "startsWith"];
    case "firstUrlHost":
      return ["hostEquals", "hostOrSubdomainOf"];
  }
}

export function operatorLabelForField(
  field: ConditionField,
  operator: string,
  i18n: I18n = EN_I18N,
): string {
  return conditionOperatorLabel(i18n, field, operator);
}

export function createCondition(field: ConditionField = "body"): ConditionV1 {
  switch (field) {
    case "priority":
      return { field, op: "equals", value: 3 };
    case "qos":
      return { field, op: "equals", value: 1 };
    case "hasAttachment":
    case "hasHttpUrl":
    case "retain":
    case "duplicate":
    case "hasCorrelationData":
      return { field, op: "equals", value: true };
    case "tag":
      return { field, op: "contains", value: "" };
    case "attachmentMime":
      return { field, op: "equals", value: "" };
    case "firstUrlHost":
      return { field, op: "hostOrSubdomainOf", value: "" };
    default:
      return { field, op: "contains", value: "" };
  }
}

export function createBlankRule(
  existingIds: readonly string[],
  templateIds: readonly string[],
  defaultName = "New rule",
): RuleV1 {
  const ids = new Set(existingIds);
  let suffix = 1;
  let id = "rule";
  while (ids.has(id)) id = `rule-${++suffix}`;
  const templateId = templateIds.includes("inbox") ? "inbox" : (templateIds[0] ?? "");
  return {
    id,
    revision: 1,
    name: defaultName,
    enabled: true,
    when: { all: [] },
    action: {
      notePathTemplate: "MQTT Sync/Inbox.md",
      contentTemplateId: templateId,
      insertion: "append",
    },
  };
}

export function summarizeCondition(condition: ConditionV1, i18n: I18n = EN_I18N): string {
  const field = conditionFieldLabel(i18n, condition.field);
  if (
    ["hasAttachment", "hasHttpUrl", "retain", "duplicate", "hasCorrelationData"].includes(
      condition.field,
    )
  ) {
    return `${field}: ${i18n.t(condition.value ? "summary.yes" : "summary.no")}`;
  }
  if (condition.field === "firstUrlHost") {
    const relation = i18n.t(
      condition.op === "hostEquals" ? "summary.hostEquals" : "summary.hostOrSubdomain",
    );
    return `${field} ${relation} “${condition.value}”`;
  }
  const operator = operatorLabelForField(condition.field, condition.op, i18n);
  const value =
    typeof condition.value === "string" ? `“${condition.value}”` : String(condition.value);
  return `${field} ${operator} ${value}`;
}

export function summarizeRule(
  rule: RuleV1,
  i18n: I18n = EN_I18N,
): {
  name: string;
  notePath: string;
  description: string;
} {
  return summarizeRuleLocalized(rule, i18n);
}

export function moveRule(rules: readonly RuleV1[], from: number, to: number): RuleV1[] {
  if (from < 0 || from >= rules.length || to < 0 || to >= rules.length || from === to) {
    return [...rules];
  }
  const result = [...rules];
  const [rule] = result.splice(from, 1);
  if (rule) result.splice(to, 0, rule);
  return result;
}

export function saveRuleDraft(rules: readonly RuleV1[], draft: RuleV1, index?: number): RuleV1[] {
  const result = rules.map((rule) => structuredClone(rule));
  const saved = structuredClone(draft);
  if (index === undefined) {
    saved.revision = 1;
    result.push(saved);
    return result;
  }
  const original = rules[index];
  if (!original) return [...rules];
  const before = JSON.stringify({ ...original, revision: 0 });
  const after = JSON.stringify({ ...saved, revision: 0 });
  saved.revision = before === after ? original.revision : original.revision + 1;
  result[index] = saved;
  return result;
}

export function removeRule(rules: readonly RuleV1[], index: number): RuleV1[] {
  if (index < 0 || index >= rules.length) return [...rules];
  return rules.filter((_, current) => current !== index);
}
