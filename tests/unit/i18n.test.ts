import { createI18n, resolvePluginLocale } from "../../src/i18n";
import { summarizeRule } from "../../src/settings/rule-editor";
import { DEFAULT_RULES } from "../../src/settings/defaults";

describe("plugin interface localization", () => {
  it("supports explicit language selection and following Obsidian", () => {
    expect(resolvePluginLocale("auto", "zh-Hans")).toBe("zh-CN");
    expect(resolvePluginLocale("auto", "en-US")).toBe("en");
    expect(resolvePluginLocale("en", "zh-CN")).toBe("en");
    expect(resolvePluginLocale("zh-CN", "en-US")).toBe("zh-CN");
  });

  it("renders one selected language instead of slash-separated bilingual labels", () => {
    const en = createI18n("en", "zh-CN");
    const zh = createI18n("zh-CN", "en-US");
    expect(en.t("settings.brokerUrl")).toBe("Broker URL");
    expect(zh.t("settings.brokerUrl")).toBe("Broker 地址");
    expect(en.t("settings.brokerUrl")).not.toContain(" / ");
    expect(zh.t("settings.brokerUrl")).not.toContain(" / ");
    expect(en.t("language.auto")).toBe("Follow Obsidian");
    expect(zh.t("language.auto")).toBe("跟随 Obsidian");
    expect(zh.t("settings.tlsCertificatesDesc")).toBe(
      "配置自定义 CA 和可选的双向 TLS 客户端证书。",
    );
    expect(zh.t("settings.qos0")).toBe("QoS 0 — 至多一次");
    expect(zh.t("settings.qos1")).toBe("QoS 1 — 至少一次");
    expect(zh.t("settings.qos2")).toBe("QoS 2 — 恰好一次");
  });

  it("localizes rule summaries while preserving user-authored values", () => {
    const rule = structuredClone(DEFAULT_RULES.rules[0]!);
    rule.name = "User rule";
    rule.when.all = [{ field: "topic", op: "matchesFilter", value: "devices/+/state" }];
    expect(summarizeRule(rule, createI18n("zh-CN", "en"))).toEqual({
      name: "User rule",
      notePath: "MQTT Sync/Inbox.md",
      description: "主题 匹配 MQTT Filter “devices/+/state”",
    });
  });
});
