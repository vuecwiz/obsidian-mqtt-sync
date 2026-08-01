import { insertBlock, VaultWriter } from "../../src/effects/vault-writer";
import { normalizeVaultPath, sanitizePathComponent } from "../../src/effects/paths";
import { planEffect } from "../../src/effects/planner";
import {
  DEFAULT_RULES,
  DEFAULT_TEMPLATES,
  createDefaultSettings,
} from "../../src/settings/defaults";
import {
  formatUtcDate,
  listTemplateTokens,
  renderTemplate,
  validateTemplate,
} from "../../src/templates/engine";
import { MemoryVault } from "../helpers/memory-vault";
import { message } from "../helpers/message";

describe("templates, paths and effect planning", () => {
  it("formats UTC timestamps deterministically and rejects format directives outside the allowlist", () => {
    const timestamp = Date.UTC(2026, 6, 29, 16, 5, 6, 7);
    expect(formatUtcDate(timestamp, "YYYY-MM-DD HH:mm:ss.SSS hh")).toBe(
      "2026-07-29 16:05:06.007 04",
    );
    expect(() => formatUtcDate(timestamp, "YYYY[quarter]")).toThrow(/format/u);
  });

  it("renders normalized MQTT metadata and preserves repeated user properties", () => {
    const value = message({
      body: "payload",
      tags: ["one", "two"],
      contentType: "application/json",
      responseTopic: "reply/topic",
      correlationData: "Y29ycmVsYXRpb24=",
      userProperties: { trace: ["a", "b"] },
      delivery: { qos: 2, retain: true, duplicate: false },
    });
    const template =
      "{{topic}}|{{payload}}|{{qos}}|{{retain}}|{{contentType}}|{{responseTopic}}|{{correlationData}}|{{userProperty:trace}}|{{tag:[1]}}";
    expect(listTemplateTokens(template)).toHaveLength(9);
    expect(renderTemplate(template, { message: value })).toBe(
      "test-topic|payload|2|true|application/json|reply/topic|Y29ycmVsYXRpb24=|a, b|two",
    );
    expect(validateTemplate("{{not-supported}}")).toEqual([
      "Unknown template variable: not-supported",
    ]);
    expect(() => renderTemplate("{{not-supported}}", { message: value }, true)).toThrow(
      /<path-token>/u,
    );
  });

  it("normalizes safe Vault-relative paths and rejects traversal, absolute and non-Markdown notes", () => {
    expect(sanitizePathComponent("  dev/ice:*?  ")).toBe("dev_ice___");
    expect(normalizeVaultPath("MQTT Sync/Inbox.md", { requireMarkdown: true })).toBe(
      "MQTT Sync/Inbox.md",
    );
    for (const unsafe of ["../outside.md", "/absolute.md", "C:\\outside.md", "a//b.md"]) {
      expect(() => normalizeVaultPath(unsafe, { requireMarkdown: true })).toThrow(/Path/u);
    }
    expect(() => normalizeVaultPath("MQTT Sync/Inbox.txt", { requireMarkdown: true })).toThrow(
      /\.md/u,
    );
  });

  it("plans link-only attachments when downloading is disabled and escapes Markdown destinations", () => {
    const settings = createDefaultSettings();
    const value = message({
      attachment: {
        url: "https://files.example/a file(1).png",
        name: "plot[1].png",
        type: "image/png",
        size: 10,
      },
    });
    const plan = planEffect(
      value,
      structuredClone(DEFAULT_RULES.rules[0]!),
      DEFAULT_TEMPLATES,
      settings.processing,
    );
    expect(plan.attachment).toMatchObject({ mode: "link-only", sourceUrl: value.attachment!.url });
    expect(plan.renderedBlock).toContain("[Attachment: plot\\[1\\].png]");
    expect(plan.renderedBlock).toContain("a%20file%281%29.png");
  });

  it("plans bounded attachment downloads only for an exact allowed origin and target template", () => {
    const settings = createDefaultSettings();
    settings.processing.downloadEnvelopeAttachments = true;
    settings.processing.allowedAttachmentOrigins = ["https://files.example"];
    const rule = structuredClone(DEFAULT_RULES.rules[0]!);
    rule.action.attachmentPathTemplate = "MQTT Sync/Attachments/{{attachment:name}}";
    const value = message({
      attachment: {
        url: "https://files.example/image.png",
        name: "image.png",
        size: 100,
        sha256: "abc123",
      },
    });
    expect(planEffect(value, rule, DEFAULT_TEMPLATES, settings.processing).attachment).toEqual({
      mode: "download",
      sourceUrl: value.attachment!.url,
      targetPath: "MQTT Sync/Attachments/image.png",
      expectedMaxBytes: settings.processing.maxAttachmentBytes,
      expectedSha256: "abc123",
    });
    value.attachment!.size = settings.processing.maxAttachmentBytes + 1;
    expect(() => planEffect(value, rule, DEFAULT_TEMPLATES, settings.processing)).toThrow(
      /configured limit/u,
    );
  });

  it("inserts after a heading without crossing the next same-level section", () => {
    const plan = {
      schemaVersion: 1 as const,
      sourceKey: "key",
      ruleId: "rule",
      ruleRevision: 1,
      notePath: "Inbox.md",
      marker: "<!-- mqtt-sync:v1 key=x rule=rule@1 -->",
      renderedBlock: "<!-- mqtt-sync:v1 key=x rule=rule@1 -->\nnew",
      insertion: { mode: "after-heading" as const, heading: "## Inbox" },
    };
    expect(insertBlock("# Root\n\n## Inbox\nold\n\n## Next\nlater\n", plan)).toBe(
      "# Root\n\n## Inbox\nold\n\n<!-- mqtt-sync:v1 key=x rule=rule@1 -->\nnew\n\n## Next\nlater\n",
    );
  });

  it("serializes concurrent Vault writes and applies each marker once", async () => {
    const vault = new MemoryVault();
    const writer = new VaultWriter(vault);
    const base = {
      schemaVersion: 1 as const,
      ruleId: "rule",
      ruleRevision: 1,
      notePath: "Inbox.md",
      insertion: { mode: "append" as const },
    };
    const first = {
      ...base,
      sourceKey: "one",
      marker: "<!-- mqtt-sync:v1 key=one rule=rule@1 -->",
      renderedBlock: "<!-- mqtt-sync:v1 key=one rule=rule@1 -->\none",
    };
    const second = {
      ...base,
      sourceKey: "two",
      marker: "<!-- mqtt-sync:v1 key=two rule=rule@1 -->",
      renderedBlock: "<!-- mqtt-sync:v1 key=two rule=rule@1 -->\ntwo",
    };
    await Promise.all([writer.execute(first), writer.execute(second), writer.execute(first)]);
    expect(vault.text.get("Inbox.md")?.match(/mqtt-sync:v1/gu)).toHaveLength(2);
    expect(await writer.inspect(first)).toBe(true);
    expect(await writer.inspect(second)).toBe(true);
  });
});
