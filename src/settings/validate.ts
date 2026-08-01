import { normalizeVaultPath } from "../effects/paths";
import { validateRuleSet, type ValidationIssue } from "../rules/engine";
import { validateTlsConfig } from "./tls";
import { validateTemplate } from "../templates/engine";
import { canonicalBrokerUrl } from "../transport/mqtt/normalizer";
import { isValidTopicFilter, isValidTopicName, topicMatchesFilter } from "../transport/mqtt/topic";

const issue = (path: string, code: string, message: string): ValidationIssue => ({
  path,
  code,
  message,
});
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
export { isValidTopicFilter as isValidMQTTTopic };

export function validateRules(rules: unknown, templates: unknown): ValidationIssue[] {
  const entries =
    record(templates) && templates.schemaVersion === 1 && record(templates.entries)
      ? templates.entries
      : {};
  const issues = validateRuleSet(rules, new Set(Object.keys(entries)));
  if (record(rules) && Array.isArray(rules.rules)) {
    for (const [index, rule] of rules.rules.entries()) {
      if (!record(rule) || !record(rule.action)) continue;
      for (const [field, markdown] of [
        ["notePathTemplate", true],
        ["attachmentPathTemplate", false],
      ] as const) {
        const template = rule.action[field];
        if (typeof template !== "string") continue;
        try {
          normalizeVaultPath(template.replace(/{{[^{}]+}}/g, "safe"), {
            requireMarkdown: markdown,
          });
        } catch (error) {
          issues.push(
            issue(
              `rules[${index}].action.${field}`,
              "PATH",
              error instanceof Error ? error.message : "Invalid path",
            ),
          );
        }
      }
    }
  }
  return issues;
}

export function validateSettings(value: unknown): ValidationIssue[] {
  if (!record(value)) return [issue("settings", "TYPE", "Settings must be an object")];
  const issues: ValidationIssue[] = [];
  if (value.schemaVersion !== 1)
    issues.push(issue("schemaVersion", "SCHEMA", "Expected schemaVersion 1"));
  if (!["auto", "en", "zh-CN"].includes(String(value.uiLanguage)))
    issues.push(issue("uiLanguage", "LANGUAGE", "Invalid plugin interface language"));
  if (typeof value.enabled !== "boolean")
    issues.push(issue("enabled", "TYPE", "enabled must be boolean"));
  if (
    !record(value.device) ||
    typeof value.device.deviceId !== "string" ||
    typeof value.device.writerDeviceId !== "string"
  )
    issues.push(issue("device", "DEVICE", "deviceId and writerDeviceId are required"));
  const templates =
    record(value.templates) &&
    value.templates.schemaVersion === 1 &&
    record(value.templates.entries)
      ? value.templates.entries
      : {};
  if (
    !record(value.templates) ||
    value.templates.schemaVersion !== 1 ||
    !record(value.templates.entries)
  )
    issues.push(issue("templates", "TYPE", "TemplateCatalog V1 is required"));
  for (const [id, template] of Object.entries(templates)) {
    if (typeof template !== "string")
      issues.push(issue(`templates.${id}`, "TYPE", "Template must be a string"));
    else
      validateTemplate(template).forEach((message) =>
        issues.push(issue(`templates.${id}`, "TEMPLATE", message)),
      );
  }
  issues.push(...validateRules(value.rules, value.templates));
  if (!Array.isArray(value.connections))
    issues.push(issue("connections", "TYPE", "connections must be an array"));
  const ids = new Set<string>();
  const clientIds = new Set<string>();
  for (const [index, raw] of (Array.isArray(value.connections) ? value.connections : []).entries())
    validateConnection(raw, index, ids, clientIds, issues);
  validateProcessing(value.processing, issues);
  if (
    !record(value.diagnostics) ||
    !["error", "info", "debug"].includes(String(value.diagnostics.logLevel)) ||
    typeof value.diagnostics.redactBodies !== "boolean"
  )
    issues.push(issue("diagnostics", "TYPE", "Invalid diagnostics configuration"));
  return issues;
}

function validateConnection(
  value: unknown,
  index: number,
  ids: Set<string>,
  clientIds: Set<string>,
  issues: ValidationIssue[],
): void {
  const path = `connections[${index}]`;
  if (!record(value)) {
    issues.push(issue(path, "TYPE", "Connection must be an object"));
    return;
  }
  const id = typeof value.id === "string" ? value.id : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id))
    issues.push(issue(`${path}.id`, "ID", "Invalid connection ID"));
  if (ids.has(id)) issues.push(issue(`${path}.id`, "DUPLICATE", "Duplicate connection ID"));
  ids.add(id);
  if (typeof value.name !== "string" || !value.name.trim())
    issues.push(issue(`${path}.name`, "NAME", "Connection name is required"));
  if (typeof value.brokerUrl !== "string")
    issues.push(issue(`${path}.brokerUrl`, "BROKER_URL", "Broker URL is required"));
  else
    try {
      canonicalBrokerUrl(value.brokerUrl, value.allowInsecureRemote === true);
    } catch (error) {
      issues.push(
        issue(
          `${path}.brokerUrl`,
          "BROKER_URL",
          error instanceof Error ? error.message : "Invalid broker URL",
        ),
      );
    }
  if (value.protocolVersion !== 4 && value.protocolVersion !== 5)
    issues.push(issue(`${path}.protocolVersion`, "PROTOCOL", "Protocol version must be 4 or 5"));
  if (typeof value.clientId !== "string" || !value.clientId || value.clientId.length > 128)
    issues.push(issue(`${path}.clientId`, "CLIENT_ID", "Stable client ID is required"));
  else if (clientIds.has(value.clientId))
    issues.push(
      issue(
        `${path}.clientId`,
        "DUPLICATE_CLIENT_ID",
        "Each connection on this device must use a unique Client ID",
      ),
    );
  else clientIds.add(value.clientId);
  if (
    !record(value.auth) ||
    (value.auth.username !== undefined && typeof value.auth.username !== "string") ||
    (value.auth.password !== undefined && typeof value.auth.password !== "string")
  )
    issues.push(issue(`${path}.auth`, "AUTH", "Invalid username/password"));
  const tlsIssue = validateTlsConfig(value.tls);
  if (tlsIssue === "TYPE")
    issues.push(issue(`${path}.tls`, "TLS", "TLS configuration must contain PEM text values"));
  if (tlsIssue === "CLIENT_PAIR")
    issues.push(
      issue(
        `${path}.tls`,
        "TLS_CLIENT_PAIR",
        "TLS client certificate and private key must be configured together",
      ),
    );
  if (typeof value.allowInsecureRemote !== "boolean")
    issues.push(
      issue(`${path}.allowInsecureRemote`, "TYPE", "allowInsecureRemote must be boolean"),
    );
  if (!positive(value.keepAliveSeconds) || !positive(value.connectTimeoutMs))
    issues.push(issue(path, "RANGE", "Keep alive and connect timeout must be positive"));
  if (
    typeof value.cleanStart !== "boolean" ||
    !Number.isInteger(value.sessionExpirySeconds) ||
    Number(value.sessionExpirySeconds) < 0 ||
    (value.cleanStart && value.sessionExpirySeconds !== 0)
  )
    issues.push(
      issue(
        `${path}.sessionExpirySeconds`,
        "SESSION",
        "Clean Start requires zero expiry; other expiry values must be non-negative integers",
      ),
    );
  const subscriptions = Array.isArray(value.subscriptions) ? value.subscriptions : [];
  if (!subscriptions.length)
    issues.push(
      issue(`${path}.subscriptions`, "SUBSCRIPTIONS", "At least one subscription is required"),
    );
  for (const [subIndex, sub] of subscriptions.entries()) {
    if (
      !record(sub) ||
      typeof sub.filter !== "string" ||
      !isValidTopicFilter(sub.filter) ||
      ![0, 1, 2].includes(Number(sub.qos)) ||
      ![0, 1, 2].includes(Number(sub.retainHandling)) ||
      typeof sub.enabled !== "boolean"
    )
      issues.push(
        issue(`${path}.subscriptions[${subIndex}]`, "SUBSCRIPTION", "Invalid MQTT subscription"),
      );
  }
  if (value.result !== undefined) {
    const result = value.result;
    if (
      !record(result) ||
      typeof result.topic !== "string" ||
      !isValidTopicName(result.topic) ||
      ![0, 1, 2].includes(Number(result.qos)) ||
      typeof result.retain !== "boolean" ||
      !["minimal", "paths"].includes(String(result.privacy))
    )
      issues.push(issue(`${path}.result`, "RESULT_TOPIC", "Invalid result publication"));
    else if (
      subscriptions.some(
        (sub) =>
          record(sub) &&
          sub.enabled &&
          typeof sub.filter === "string" &&
          topicMatchesFilter(sub.filter, result.topic as string),
      )
    )
      issues.push(
        issue(
          `${path}.result.topic`,
          "RESULT_LOOP",
          "Result topic is matched by an input subscription",
        ),
      );
  }
  if (
    !record(value.reconnect) ||
    !positive(value.reconnect.minMs) ||
    !positive(value.reconnect.maxMs) ||
    Number(value.reconnect.maxMs) < Number(value.reconnect.minMs)
  )
    issues.push(issue(`${path}.reconnect`, "RANGE", "Invalid reconnect bounds"));
}

function validateProcessing(value: unknown, issues: ValidationIssue[]): void {
  if (!record(value)) {
    issues.push(issue("processing", "TYPE", "Processing configuration is required"));
    return;
  }
  for (const field of [
    "dedupeWindowSeconds",
    "maxPayloadBytes",
    "maxAttachmentBytes",
    "attachmentTimeoutMs",
    "maxAttempts",
    "concurrency",
    "completedRetentionDays",
    "completedRetentionCount",
  ])
    if (!positive(value[field]))
      issues.push(issue(`processing.${field}`, "RANGE", `${field} must be positive`));
  if (Number(value.maxPayloadBytes) > 1024 * 1024)
    issues.push(issue("processing.maxPayloadBytes", "RANGE", "Payload hard cap is 1 MiB"));
  if (Number(value.maxAttachmentBytes) > 100 * 1024 * 1024)
    issues.push(issue("processing.maxAttachmentBytes", "RANGE", "Attachment hard cap is 100 MiB"));
  if (
    !Array.isArray(value.allowedAttachmentOrigins) ||
    value.allowedAttachmentOrigins.some((origin) => {
      try {
        const url = new URL(String(origin));
        return url.protocol !== "https:" || url.origin !== origin;
      } catch {
        return true;
      }
    })
  )
    issues.push(
      issue(
        "processing.allowedAttachmentOrigins",
        "ATTACHMENT_ORIGIN",
        "Attachment origins must be exact HTTPS origins",
      ),
    );
  if (typeof value.downloadEnvelopeAttachments !== "boolean")
    issues.push(
      issue(
        "processing.downloadEnvelopeAttachments",
        "TYPE",
        "downloadEnvelopeAttachments must be boolean",
      ),
    );
}
