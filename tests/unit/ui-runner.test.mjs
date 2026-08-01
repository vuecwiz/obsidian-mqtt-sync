import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  assertExplicitTestVault,
  backupPluginSettings,
  hasCapturedErrors,
  parseEvalJson,
  readPngDimensions,
  restorePluginSettings,
  syntheticSettings,
} from "../../scripts/ui-acceptance.mjs";
import { runObsidianCli } from "../../scripts/obsidian-cli-runner.mjs";
import { parseResolutions, readPngEvidence } from "../../scripts/ui-resolution-samples.mjs";
import { loadDocumentedUiTestCaBundle } from "../../scripts/ui-test-ca-fixture.mjs";

describe("isolated Obsidian UI runner", () => {
  it("accepts only an explicitly named vanotes-test Vault", () => {
    expect(basename(assertExplicitTestVault("/tmp/vanotes-test"))).toBe("vanotes-test");
    expect(() => assertExplicitTestVault("/tmp/other-test")).toThrow(/vanotes-test/u);
    expect(() => assertExplicitTestVault("/vaults/production")).toThrow(/vanotes-test/u);
    expect(() => assertExplicitTestVault(undefined)).toThrow(/required/u);
    expect(() => runObsidianCli("vanotes", ["dev:errors"])).toThrow(/vanotes-test/u);
  });

  it("restores stranded and current settings backups without exposing bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mqtt-ui-runner-"));
    const data = join(directory, "data.json");
    const backup = join(directory, "data.ui-acceptance-backup.json");
    await writeFile(data, "current", { mode: 0o600 });
    await writeFile(backup, "original", { mode: 0o600 });

    const snapshot = await backupPluginSettings(directory);
    expect(await readFile(data, "utf8")).toBe("original");
    expect(await readFile(backup, "utf8")).toBe("original");
    await writeFile(data, "synthetic");
    await restorePluginSettings(snapshot);

    expect(await readFile(data, "utf8")).toBe("original");
    expect((await stat(data)).mode & 0o777).toBe(0o600);
    await expect(stat(backup)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes synthetic settings when the plugin had no original data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mqtt-ui-runner-"));
    const snapshot = await backupPluginSettings(directory);
    await writeFile(snapshot.data, "synthetic");
    await chmod(snapshot.data, 0o600);
    await restorePluginSettings(snapshot);
    await expect(stat(snapshot.data)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("parses CLI eval results, error baselines, and native PNG dimensions", async () => {
    expect(parseEvalJson('=> {"ok":true}\n')).toEqual({ ok: true });
    expect(parseEvalJson('=> "{\\"ok\\":true}"\n')).toEqual({ ok: true });
    expect(hasCapturedErrors("No errors captured.")).toBe(false);
    expect(hasCapturedErrors("No console messages captured.")).toBe(false);
    expect(hasCapturedErrors("TypeError: synthetic")).toBe(true);

    const directory = await mkdtemp(join(tmpdir(), "mqtt-ui-runner-"));
    const pngPath = join(directory, "scene.png");
    const png = Buffer.alloc(24);
    png.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    png.writeUInt32BE(1440, 16);
    png.writeUInt32BE(900, 20);
    await writeFile(pngPath, png);
    expect(await readPngDimensions(pngPath)).toEqual({ bytes: 24, width: 1440, height: 900 });
  });

  it("uses MQTT-specific and Ntfy-inspired synthetic distribution rules", () => {
    const rules = syntheticSettings().rules.rules;
    const conditions = rules.flatMap((rule) => rule.when.all);
    const attachmentRule = rules.find((rule) => rule.id === "ui-priority-images");

    expect(rules).toHaveLength(7);
    expect(rules.at(-1)).toMatchObject({
      id: "ui-fallback",
      when: { all: [] },
      action: { insertion: "append" },
    });
    expect(conditions).toEqual(
      expect.arrayContaining([
        { field: "topic", op: "matchesFilter", value: "mqtt-sync/ui/+/alert" },
        { field: "qos", op: "gte", value: 1 },
        { field: "retain", op: "equals", value: false },
        { field: "firstUrlHost", op: "hostOrSubdomainOf", value: "alpha.example" },
        { field: "hasHttpUrl", op: "equals", value: true },
      ]),
    );
    expect(rules.filter((rule) => rule.action.insertion === "after-heading")).toHaveLength(3);
    expect(attachmentRule?.when.all).toEqual([
      { field: "firstUrlHost", op: "hostEquals", value: "files.example" },
      { field: "priority", op: "gte", value: 4 },
      { field: "hasAttachment", op: "equals", value: true },
      { field: "attachmentMime", op: "startsWith", value: "image/" },
    ]);
  });

  it("defines and validates the maintained UI resolution matrix", () => {
    expect(parseResolutions()).toEqual([
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
    ]);
    expect(parseResolutions("1280x720,1920x1080")).toEqual([
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
    ]);
    expect(() => parseResolutions("720x500")).toThrow(/desktop minimum/u);

    const png = Buffer.alloc(24);
    png.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    png.writeUInt32BE(1280, 16);
    png.writeUInt32BE(720, 20);
    expect(readPngEvidence(png, { width: 1280, height: 720 }, "sample.png")).toMatchObject({
      path: "sample.png",
      width: 1280,
      height: 720,
      bytes: 24,
    });
    expect(() => readPngEvidence(png, { width: 1440, height: 900 }, "sample.png")).toThrow(
      /expected 1440x900/u,
    );
  });

  it("loads the documented, currently valid CA bundle without exposing certificate details", async () => {
    const fixture = await loadDocumentedUiTestCaBundle(new Date("2026-07-31T00:00:00Z"));
    expect(fixture.certificateCount).toBe(2);
    expect(fixture.lines).toBeGreaterThan(40);
    expect(fixture.bytes).toBeGreaterThan(2_000);
    expect(fixture.sha256).toMatch(/^[a-f0-9]{12}$/u);
    expect(syntheticSettings(fixture.pem).connections[0].tls.caPem).toBe(fixture.pem);
  });
});
