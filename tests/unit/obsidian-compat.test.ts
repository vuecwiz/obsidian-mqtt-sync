import { readFile } from "node:fs/promises";
import { createI18n } from "../../src/i18n";
import { createDefaultSettings } from "../../src/settings/defaults";
import { MQTTSyncSettingTab } from "../../src/settings/tab";

function pluginStub() {
  return {
    settings: createDefaultSettings(),
    i18n: createI18n("en", "en"),
    saveSettings: vi.fn(async () => undefined),
    setUiLanguage: vi.fn(async () => undefined),
  };
}

describe("Obsidian settings API compatibility", () => {
  it("provides searchable 1.13 definitions while retaining the 1.12.7 display fallback", () => {
    const plugin = pluginStub();
    const tab = new MQTTSyncSettingTab({} as never, plugin as never);
    const definitions = tab.getSettingDefinitions();
    const groups = definitions.filter((item) => "type" in item && item.type === "group");
    const items = groups.flatMap((group) => ("items" in group ? (group.items ?? []) : []));

    expect(groups.map((group) => ("heading" in group ? group.heading : undefined))).toEqual([
      "MQTT Sync",
      "",
      "Subscription",
      "Result publication",
      "Limits and attachments",
      "",
      "Language",
    ]);
    expect(items.length).toBeGreaterThan(20);
    expect(items.some((item) => "aliases" in item && item.aliases?.includes("设备身份"))).toBe(
      true,
    );
    expect(tab.getControlValue("clientId")).toBe("");
    expect(groups.flatMap((group) => ("items" in group ? (group.items ?? []) : []))).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Inbox" })]),
    );
    expect(JSON.stringify(definitions)).not.toContain(" / ");
    const clientId = items.find((item) => "name" in item && item.name === "Client ID");
    expect(clientId && "control" in clientId ? clientId.control : undefined).not.toHaveProperty(
      "validate",
    );
    expect(items).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "TLS certificates" })]),
    );
    const allowInsecureIndex = items.findIndex(
      (item) => "name" in item && item.name === "Allow insecure remote transport",
    );
    const tlsIndex = items.findIndex((item) => "name" in item && item.name === "TLS certificates");
    expect(allowInsecureIndex).toBeGreaterThanOrEqual(0);
    expect(tlsIndex).toBeGreaterThan(allowInsecureIndex);
    const requestedQos = items.find((item) => "name" in item && item.name === "Requested QoS");
    expect(requestedQos && "control" in requestedQos ? requestedQos.control : undefined).toEqual(
      expect.objectContaining({
        options: {
          "0": "QoS 0 — At most once",
          "1": "QoS 1 — At least once",
          "2": "QoS 2 — Exactly once",
        },
      }),
    );
    const resultQos = items.find((item) => "name" in item && item.name === "Result QoS");
    expect(resultQos && "control" in resultQos ? resultQos.control : undefined).toEqual(
      expect.objectContaining({
        options: {
          "0": "QoS 0 — At most once",
          "1": "QoS 1 — At least once",
          "2": "QoS 2 — Exactly once",
        },
      }),
    );
    expect(items.some((item) => "name" in item && item.name === "TLS private key (PEM)")).toBe(
      false,
    );
    expect(typeof tab.display).toBe("function");
  });

  it("persists declarative values and rejects unknown control keys", async () => {
    const plugin = pluginStub();
    const tab = new MQTTSyncSettingTab({} as never, plugin as never);

    await tab.setControlValue("clientId", " explicit-device-client ");
    expect(tab.getControlValue("clientId")).toBe("explicit-device-client");
    expect(plugin.saveSettings).toHaveBeenCalledWith(false);
    await expect(tab.setControlValue("not-a-setting", true)).rejects.toThrow(/Unknown/u);

    await tab.setControlValue("allowInsecureRemote", true);
    expect(plugin.settings.connections[0]?.allowInsecureRemote).toBe(true);
  });

  it("uses declarative refresh when available and the internal legacy renderer otherwise", () => {
    const tab = new MQTTSyncSettingTab({} as never, pluginStub() as never) as unknown as {
      update?: () => void;
      refreshSettings: () => void;
      renderLegacySettings: () => void;
    };
    const update = vi.fn();
    const renderLegacySettings = vi.fn();
    tab.update = update;
    tab.renderLegacySettings = renderLegacySettings;

    tab.refreshSettings();
    expect(update).toHaveBeenCalledOnce();
    expect(renderLegacySettings).not.toHaveBeenCalled();

    tab.update = undefined;
    tab.refreshSettings();
    expect(renderLegacySettings).toHaveBeenCalledOnce();
  });

  it("uses Setting headings and window-scoped renderer timers", async () => {
    const [settingsSource, connectionSource, attachmentSource] = await Promise.all([
      readFile(new URL("../../src/settings/tab.ts", import.meta.url), "utf8"),
      readFile(new URL("../../src/transport/mqtt/connection.ts", import.meta.url), "utf8"),
      readFile(new URL("../../src/effects/attachment.ts", import.meta.url), "utf8"),
    ]);

    expect(settingsSource).not.toMatch(/createEl\(["']h[1-6]["']/u);
    expect(settingsSource.match(/\.setHeading\(\)/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(settingsSource).not.toMatch(/\bthis\.(?:display|update)\(\)/u);
    expect(settingsSource).toContain("this.renderLegacySettings();");
    expect(connectionSource).not.toMatch(/(?<![.\w])(?:setTimeout|clearTimeout)\(/u);
    expect(attachmentSource).not.toMatch(/(?<![.\w])(?:setTimeout|clearTimeout)\(/u);
  });
});
