import { DEFAULT_RULES } from "../../src/settings/defaults";
import {
  createBlankRule,
  createCondition,
  moveRule,
  operatorsForField,
  removeRule,
  saveRuleDraft,
  summarizeRule,
} from "../../src/settings/rule-editor";

describe("message distribution rule editor model", () => {
  it("creates a unique MQTT rule draft with a valid default action", () => {
    expect(createBlankRule(["rule", "rule-2"], ["raw", "inbox"], "New rule")).toMatchObject({
      id: "rule-3",
      revision: 1,
      enabled: true,
      when: { all: [] },
      action: {
        notePathTemplate: "MQTT Sync/Inbox.md",
        contentTemplateId: "inbox",
        insertion: "append",
      },
    });
  });

  it("provides typed defaults and operators for MQTT fields", () => {
    expect(createCondition("qos")).toEqual({ field: "qos", op: "equals", value: 1 });
    expect(createCondition("retain")).toEqual({ field: "retain", op: "equals", value: true });
    expect(createCondition("topic")).toEqual({ field: "topic", op: "contains", value: "" });
    expect(operatorsForField("topic")).toEqual([
      "equals",
      "contains",
      "startsWith",
      "matchesFilter",
    ]);
    expect(operatorsForField("hasCorrelationData")).toEqual(["equals"]);
  });

  it("moves, adds, edits and removes rules with deterministic revisions", () => {
    const original = ["one", "two"].map((id) => ({
      ...structuredClone(DEFAULT_RULES.rules[0]!),
      id,
    }));
    expect(moveRule(original, 1, 0).map((rule) => rule.id)).toEqual(["two", "one"]);

    const added = createBlankRule(
      original.map((rule) => rule.id),
      ["inbox"],
    );
    added.revision = 99;
    expect(saveRuleDraft(original, added).at(-1)).toMatchObject({ id: "rule", revision: 1 });

    const edited = structuredClone(original[0]!);
    edited.name = "Renamed";
    expect(saveRuleDraft(original, edited, 0)[0]).toMatchObject({
      name: "Renamed",
      revision: original[0]!.revision + 1,
    });
    expect(removeRule(original, 0).map((rule) => rule.id)).toEqual(["two"]);
  });

  it("summarizes order-relevant state without changing persisted rules", () => {
    const rule = structuredClone(DEFAULT_RULES.rules[0]!);
    rule.enabled = false;
    rule.when.all = [{ field: "topic", op: "matchesFilter", value: "alerts/#" }];
    expect(summarizeRule(rule).description).toBe("Disabled · Topic matches MQTT filter “alerts/#”");
    expect(DEFAULT_RULES.rules[0]!.enabled).toBe(true);
  });
});
