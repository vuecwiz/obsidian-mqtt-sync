import { readFile } from "node:fs/promises";

describe("Obsidian community review compliance", () => {
  it("attests every supported release asset with the required GitHub permissions", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toMatch(/^\s{2}attestations: write$/mu);
    expect(workflow).toMatch(/^\s{2}contents: write$/mu);
    expect(workflow).toMatch(/^\s{2}id-token: write$/mu);
    expect(workflow).toContain("uses: actions/attest@v4");
    expect(workflow).toMatch(/subject-path:\s*\|\s*main\.js\s*manifest\.json\s*styles\.css/su);
    expect(workflow.indexOf("uses: actions/attest@v4")).toBeGreaterThan(
      workflow.indexOf("npm run package:release"),
    );
    expect(workflow.indexOf("uses: actions/attest@v4")).toBeLessThan(
      workflow.indexOf("name: Create GitHub release"),
    );
  });

  it("does not retain the unnecessary assertions reported by the source review", async () => {
    const [migration, normalizer] = await Promise.all([
      readFile(new URL("../../src/settings/migrate.ts", import.meta.url), "utf8"),
      readFile(new URL("../../src/transport/mqtt/normalizer.ts", import.meta.url), "utf8"),
    ]);

    expect(migration).not.toContain('data.connections as PersistedSettingsV1["connections"]');
    expect(normalizer).not.toContain("qos as MqttQos");
  });
});
