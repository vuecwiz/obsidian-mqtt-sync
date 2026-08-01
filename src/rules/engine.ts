import { domainToASCII } from "node:url";
import type { ConditionV1, IncomingMessage, RuleSetV1, RuleV1 } from "../domain/types";
import { isValidTopicFilter, topicMatchesFilter } from "../transport/mqtt/topic";

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type RuleMatch = { kind: "matched"; rule: RuleV1 } | { kind: "none" };

const CONDITION_OPERATORS: Record<string, readonly string[]> = {
  topic: ["equals", "contains", "startsWith", "matchesFilter"],
  title: ["equals", "contains", "startsWith"],
  body: ["equals", "contains", "startsWith"],
  tag: ["contains"],
  priority: ["equals", "gte"],
  hasAttachment: ["equals"],
  hasHttpUrl: ["equals"],
  attachmentMime: ["equals", "startsWith"],
  firstUrlHost: ["hostEquals", "hostOrSubdomainOf"],
  contentType: ["equals", "contains", "startsWith"],
  responseTopic: ["equals", "contains", "startsWith"],
  qos: ["equals", "gte"],
  retain: ["equals"],
  duplicate: ["equals"],
  hasCorrelationData: ["equals"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hostMatches(actual: string, configured: string, includeSubdomains: boolean): boolean {
  const expected = domainToASCII(configured.trim().replace(/^\.+|\.+$/g, "")).toLowerCase();
  if (!expected) return false;
  return actual === expected || (includeSubdomains && actual.endsWith(`.${expected}`));
}

export function evaluateCondition(message: IncomingMessage, condition: ConditionV1): boolean {
  switch (condition.field) {
    case "topic":
    case "title":
    case "body":
    case "contentType":
    case "responseTopic": {
      const value =
        condition.field === "topic"
          ? message.source.topic
          : condition.field === "title"
            ? message.title
            : condition.field === "body"
              ? message.body
              : condition.field === "contentType"
                ? (message.contentType ?? "")
                : (message.responseTopic ?? "");
      if (condition.field === "topic" && condition.op === "matchesFilter")
        return topicMatchesFilter(condition.value, value);
      if (condition.op === "equals") return value === condition.value;
      if (condition.op === "contains") return value.includes(condition.value);
      return value.startsWith(condition.value);
    }
    case "tag":
      return message.tags.includes(condition.value);
    case "priority":
      return condition.op === "equals"
        ? message.priority === condition.value
        : message.priority >= condition.value;
    case "qos":
      return condition.op === "equals"
        ? message.delivery.qos === condition.value
        : message.delivery.qos >= condition.value;
    case "retain":
      return message.delivery.retain === condition.value;
    case "duplicate":
      return message.delivery.duplicate === condition.value;
    case "hasCorrelationData":
      return Boolean(message.correlationData) === condition.value;
    case "hasAttachment":
      return Boolean(message.attachment) === condition.value;
    case "hasHttpUrl":
      return Boolean(message.firstUrl) === condition.value;
    case "attachmentMime": {
      const mime = message.attachment?.type ?? "";
      return condition.op === "equals"
        ? mime === condition.value
        : mime.startsWith(condition.value);
    }
    case "firstUrlHost":
      return message.firstUrl
        ? hostMatches(
            message.firstUrl.hostname,
            condition.value,
            condition.op === "hostOrSubdomainOf",
          )
        : false;
  }
}

export function validateRuleSet(rules: unknown, templateIds?: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(rules)) {
    return [{ path: "rules", code: "TYPE", message: "RuleSet must be an object" }];
  }
  if (rules.schemaVersion !== 1) {
    issues.push({ path: "schemaVersion", code: "SCHEMA", message: "Expected schemaVersion 1" });
  }
  if (rules.matchMode !== "first") {
    issues.push({
      path: "matchMode",
      code: "MATCH_MODE",
      message: "Only first-match is supported",
    });
  }
  if (!Array.isArray(rules.rules)) {
    issues.push({ path: "rules", code: "TYPE", message: "rules must be an array" });
    return issues;
  }
  const ids = new Set<string>();
  rules.rules.forEach((rawRule, index) => {
    const path = `rules[${index}]`;
    if (!isRecord(rawRule)) {
      issues.push({ path, code: "TYPE", message: "Rule must be an object" });
      return;
    }
    const rule = rawRule as Partial<RuleV1>;
    if (typeof rule.name !== "string" || !rule.name.trim()) {
      issues.push({ path: `${path}.name`, code: "NAME", message: "Rule name is required" });
    }
    if (typeof rule.enabled !== "boolean") {
      issues.push({ path: `${path}.enabled`, code: "TYPE", message: "enabled must be boolean" });
    }
    const ruleId = typeof rule.id === "string" ? rule.id : "";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(ruleId)) {
      issues.push({ path: `${path}.id`, code: "ID", message: "Invalid rule ID" });
    }
    if (ids.has(ruleId)) {
      issues.push({ path: `${path}.id`, code: "DUPLICATE", message: "Duplicate rule ID" });
    }
    ids.add(ruleId);
    const revision = typeof rule.revision === "number" ? rule.revision : Number.NaN;
    if (!Number.isInteger(revision) || revision < 1) {
      issues.push({ path: `${path}.revision`, code: "REVISION", message: "Invalid revision" });
    }
    if (!isRecord(rule.when) || !Array.isArray(rule.when.all)) {
      issues.push({ path: `${path}.when.all`, code: "TYPE", message: "when.all must be an array" });
    } else {
      rule.when.all.forEach((condition, conditionIndex) => {
        validateConditionShape(condition, `${path}.when.all[${conditionIndex}]`, issues);
      });
    }
    if (!isRecord(rule.action)) {
      issues.push({ path: `${path}.action`, code: "TYPE", message: "action must be an object" });
      return;
    }
    if (
      typeof rule.action.notePathTemplate !== "string" ||
      !rule.action.notePathTemplate.endsWith(".md")
    ) {
      issues.push({
        path: `${path}.action.notePathTemplate`,
        code: "NOTE_EXTENSION",
        message: "Note path template must end in .md",
      });
    }
    if (
      typeof rule.action.contentTemplateId !== "string" ||
      (templateIds && !templateIds.has(rule.action.contentTemplateId))
    ) {
      issues.push({
        path: `${path}.action.contentTemplateId`,
        code: "TEMPLATE_MISSING",
        message: "Unknown content template",
      });
    }
    if (
      rule.action.insertion !== "append" &&
      rule.action.insertion !== "prepend" &&
      rule.action.insertion !== "after-heading"
    ) {
      issues.push({
        path: `${path}.action.insertion`,
        code: "INSERTION",
        message: "Invalid insertion mode",
      });
    }
    if (rule.action.insertion === "after-heading" && !rule.action.heading?.trim()) {
      issues.push({
        path: `${path}.action.heading`,
        code: "HEADING_REQUIRED",
        message: "after-heading requires a heading",
      });
    }
  });
  return issues;
}

function validateConditionShape(condition: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(condition) || typeof condition.field !== "string") {
    issues.push({ path, code: "CONDITION", message: "Condition must have a known field" });
    return;
  }
  const operators = CONDITION_OPERATORS[condition.field];
  if (!operators || typeof condition.op !== "string" || !operators.includes(condition.op)) {
    issues.push({ path: `${path}.op`, code: "CONDITION", message: "Invalid condition operator" });
  }
  const expectedType =
    condition.field === "priority" || condition.field === "qos"
      ? "number"
      : condition.field === "hasAttachment" ||
          condition.field === "hasHttpUrl" ||
          condition.field === "retain" ||
          condition.field === "duplicate" ||
          condition.field === "hasCorrelationData"
        ? "boolean"
        : "string";
  if (typeof condition.value !== expectedType) {
    issues.push({ path: `${path}.value`, code: "CONDITION", message: "Invalid condition value" });
  } else if (expectedType === "string" && !(condition.value as string).trim()) {
    issues.push({
      path: `${path}.value`,
      code: "CONDITION_VALUE",
      message: "Condition value is required; remove all conditions to match every message",
    });
  }
  if (
    condition.field === "topic" &&
    condition.op === "matchesFilter" &&
    typeof condition.value === "string" &&
    !isValidTopicFilter(condition.value)
  )
    issues.push({
      path: `${path}.value`,
      code: "CONDITION_VALUE",
      message: "Invalid MQTT topic filter",
    });
}

export function matchRule(message: IncomingMessage, rules: RuleSetV1): RuleMatch {
  for (const rule of rules.rules) {
    if (rule.enabled && rule.when.all.every((condition) => evaluateCondition(message, condition))) {
      return { kind: "matched", rule };
    }
  }
  return { kind: "none" };
}
