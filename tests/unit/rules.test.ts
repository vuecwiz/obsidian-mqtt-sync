import type { RuleSetV1 } from "../../src/domain/types";
import { evaluateCondition, matchRule, validateRuleSet } from "../../src/rules/engine";
import { DEFAULT_RULES, DEFAULT_TEMPLATES } from "../../src/settings/defaults";
import { message } from "../helpers/message";

function routingRules(): RuleSetV1 {
  return {
    schemaVersion: 1,
    matchMode: "first",
    rules: [
      {
        id: "critical-sensor",
        revision: 1,
        name: "Critical sensor",
        enabled: true,
        when: {
          all: [
            { field: "topic", op: "matchesFilter", value: "sensors/+/alert" },
            { field: "qos", op: "gte", value: 1 },
            { field: "retain", op: "equals", value: false },
          ],
        },
        action: {
          notePathTemplate: "MQTT Sync/Critical.md",
          contentTemplateId: "inbox",
          insertion: "prepend",
        },
      },
      {
        id: "sensor-fallback",
        revision: 1,
        name: "Sensor fallback",
        enabled: true,
        when: { all: [{ field: "topic", op: "matchesFilter", value: "sensors/#" }] },
        action: {
          notePathTemplate: "MQTT Sync/Sensors.md",
          contentTemplateId: "inbox",
          insertion: "append",
        },
      },
      structuredClone(DEFAULT_RULES.rules[0]!),
    ],
  };
}

describe("MQTT message distribution rule engine", () => {
  it("routes top-to-bottom and requires every condition in the first matching rule", () => {
    const rules = routingRules();
    const critical = matchRule(
      message({
        source: { topic: "sensors/kitchen/alert" },
        delivery: { qos: 2, retain: false, duplicate: false },
      }),
      rules,
    );
    const retained = matchRule(
      message({
        source: { topic: "sensors/kitchen/alert" },
        delivery: { qos: 1, retain: true, duplicate: false },
      }),
      rules,
    );
    const other = matchRule(message({ source: { topic: "devices/a/state" } }), rules);

    expect(critical.kind === "matched" && critical.rule.id).toBe("critical-sensor");
    expect(retained.kind === "matched" && retained.rule.id).toBe("sensor-fallback");
    expect(other.kind === "matched" && other.rule.id).toBe("inbox");
  });

  it("supports normalized MQTT fields exposed by the rule editor", () => {
    const value = message({
      source: { topic: "devices/a/state" },
      body: "temperature warning",
      contentType: "application/json",
      responseTopic: "devices/a/reply",
      correlationData: "Y29ycmVsYXRpb24=",
      delivery: { qos: 2, retain: true, duplicate: true },
    });

    expect(
      evaluateCondition(value, { field: "topic", op: "matchesFilter", value: "devices/+/state" }),
    ).toBe(true);
    expect(evaluateCondition(value, { field: "body", op: "contains", value: "warning" })).toBe(
      true,
    );
    expect(evaluateCondition(value, { field: "qos", op: "equals", value: 2 })).toBe(true);
    expect(evaluateCondition(value, { field: "retain", op: "equals", value: true })).toBe(true);
    expect(evaluateCondition(value, { field: "duplicate", op: "equals", value: true })).toBe(true);
    expect(
      evaluateCondition(value, { field: "contentType", op: "startsWith", value: "application/" }),
    ).toBe(true);
    expect(
      evaluateCondition(value, { field: "responseTopic", op: "equals", value: "devices/a/reply" }),
    ).toBe(true);
    expect(
      evaluateCondition(value, { field: "hasCorrelationData", op: "equals", value: true }),
    ).toBe(true);
  });

  it("matches an exact URL host or its subdomains without accepting lookalike hosts", () => {
    const condition = {
      field: "firstUrlHost",
      op: "hostOrSubdomainOf",
      value: "alpha.example",
    } as const;

    expect(
      evaluateCondition(
        message({
          firstUrl: {
            raw: "https://alpha.example/item",
            protocol: "https:",
            hostname: "alpha.example",
          },
        }),
        condition,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        message({
          firstUrl: {
            raw: "https://assets.alpha.example/item",
            protocol: "https:",
            hostname: "assets.alpha.example",
          },
        }),
        condition,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        message({
          firstUrl: {
            raw: "https://evilalpha.example/item",
            protocol: "https:",
            hostname: "evilalpha.example",
          },
        }),
        condition,
      ),
    ).toBe(false);
  });

  it("supports the Ntfy-inspired URL and attachment rule shapes with deterministic first match", () => {
    const rules: RuleSetV1 = {
      schemaVersion: 1,
      matchMode: "first",
      rules: [
        {
          id: "priority-images",
          revision: 1,
          name: "Priority images",
          enabled: true,
          when: {
            all: [
              { field: "firstUrlHost", op: "hostEquals", value: "files.example" },
              { field: "priority", op: "gte", value: 4 },
              { field: "hasAttachment", op: "equals", value: true },
              { field: "attachmentMime", op: "startsWith", value: "image/" },
            ],
          },
          action: {
            notePathTemplate: "MQTT Sync/Priority Images.md",
            contentTemplateId: "inbox",
            insertion: "append",
          },
        },
        {
          id: "web-links",
          revision: 1,
          name: "Web links",
          enabled: true,
          when: { all: [{ field: "hasHttpUrl", op: "equals", value: true }] },
          action: {
            notePathTemplate: "MQTT Sync/Web Links.md",
            contentTemplateId: "inbox",
            insertion: "after-heading",
            heading: "### Links",
          },
        },
        structuredClone(DEFAULT_RULES.rules[0]!),
      ],
    };
    const priorityImage = message({
      priority: 4,
      firstUrl: {
        raw: "https://files.example/photo.png",
        protocol: "https:",
        hostname: "files.example",
      },
      attachment: {
        name: "photo.png",
        url: "https://files.example/photo.png",
        type: "image/png",
      },
    });
    const ordinaryLink = message({
      firstUrl: {
        raw: "https://alpha.example/article",
        protocol: "https:",
        hostname: "alpha.example",
      },
    });
    const wrongMime = message({
      priority: 5,
      firstUrl: {
        raw: "https://files.example/report.pdf",
        protocol: "https:",
        hostname: "files.example",
      },
      attachment: {
        name: "report.pdf",
        url: "https://files.example/report.pdf",
        type: "application/pdf",
      },
    });

    expect(matchRule(priorityImage, rules)).toMatchObject({
      kind: "matched",
      rule: { id: "priority-images" },
    });
    expect(matchRule(ordinaryLink, rules)).toMatchObject({
      kind: "matched",
      rule: { id: "web-links" },
    });
    expect(matchRule(wrongMime, rules)).toMatchObject({
      kind: "matched",
      rule: { id: "web-links" },
    });
    expect(validateRuleSet(rules, new Set(Object.keys(DEFAULT_TEMPLATES.entries)))).toEqual([]);
  });

  it("rejects invalid filters, empty values, duplicate IDs and missing templates", () => {
    const invalid = routingRules();
    invalid.rules[0]!.when.all[0] = { field: "topic", op: "matchesFilter", value: "bad/#/filter" };
    invalid.rules[1]!.id = invalid.rules[0]!.id;
    invalid.rules[1]!.action.contentTemplateId = "missing";

    expect(
      validateRuleSet(invalid, new Set(Object.keys(DEFAULT_TEMPLATES.entries))).map(
        (issue) => issue.code,
      ),
    ).toEqual(expect.arrayContaining(["CONDITION_VALUE", "DUPLICATE", "TEMPLATE_MISSING"]));
  });

  it("returns none when no enabled rule matches", () => {
    const rules = routingRules();
    rules.rules.forEach((rule) => (rule.enabled = false));
    expect(matchRule(message(), rules)).toEqual({ kind: "none" });
  });
});
