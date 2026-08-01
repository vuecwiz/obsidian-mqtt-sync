import {
  Notice,
  PluginSettingTab,
  Setting,
  type App,
  type SettingDefinitionItem,
  type SettingDefinitionRender,
} from "obsidian";
import type MQTTSyncPlugin from "../main";
import type {
  ConnectionConfigV1,
  MqttAuthConfig,
  RuleV1,
  UiLanguageSetting,
} from "../domain/types";
import { localizeValidationIssue, type I18n } from "../i18n";
import { MessageDistributionRuleModal } from "../ui/rule-modal";
import { TlsCertificateModal } from "../ui/tls-certificate-modal";
import { moveRule, removeRule, saveRuleDraft, summarizeRule } from "./rule-editor";
import { validateSettings } from "./validate";

function emptyConnection(): ConnectionConfigV1 {
  return {
    id: "primary",
    name: "Primary broker",
    brokerUrl: "mqtts://broker.example:8883",
    protocolVersion: 5,
    clientId: "",
    auth: {},
    tls: {},
    allowInsecureRemote: false,
    keepAliveSeconds: 60,
    connectTimeoutMs: 30_000,
    cleanStart: false,
    sessionExpirySeconds: 86_400,
    subscriptions: [
      {
        filter: "obsidian/inbox/#",
        qos: 1,
        noLocal: true,
        retainAsPublished: true,
        retainHandling: 1,
        enabled: true,
      },
    ],
    reconnect: { minMs: 1_000, maxMs: 60_000, jitterRatio: 1 },
    useCorrelationDataAsId: false,
  };
}

export function cloneAuthWithoutSecrets(auth: MqttAuthConfig): Record<string, unknown> {
  return {
    configured: Boolean(auth.username || auth.password),
    hasUsername: Boolean(auth.username),
    hasPassword: Boolean(auth.password),
  };
}

export class MQTTSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: MQTTSyncPlugin,
  ) {
    super(app, plugin);
  }

  private connection(): ConnectionConfigV1 {
    const connection = this.plugin.settings.connections[0] ?? emptyConnection();
    if (!this.plugin.settings.connections.length) this.plugin.settings.connections.push(connection);
    return connection;
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const i18n = this.plugin.i18n;
    const t: I18n["t"] = (key, variables) => i18n.t(key, variables);
    const connection = this.connection();
    const text = (key: string, placeholder?: string) => ({
      type: "text" as const,
      key,
      placeholder,
    });
    const number = (key: string) => ({ type: "number" as const, key });
    const toggle = (key: string) => ({ type: "toggle" as const, key });
    const dropdown = (key: string, options: Record<string, string>) => ({
      type: "dropdown" as const,
      key,
      options,
    });
    const qosOptions = {
      "0": t("settings.qos0"),
      "1": t("settings.qos1"),
      "2": t("settings.qos2"),
    };
    const renderItem = (
      name: string,
      desc: string | undefined,
      render: (setting: Setting) => void,
    ): SettingDefinitionRender => ({
      name,
      ...(desc === undefined ? {} : { desc }),
      searchable: true,
      render: (setting) => {
        this.decorateContainer();
        render(setting);
      },
    });
    const ruleItems: SettingDefinitionRender[] = [];
    if (this.plugin.settings.rules.rules.length) {
      for (const [index, rule] of this.plugin.settings.rules.rules.entries()) {
        const info = summarizeRule(rule, i18n);
        ruleItems.push(
          renderItem(info.name, info.description, (setting) => {
            this.markDeclarativeRuleList(setting);
            this.configureRuleSetting(setting, rule, index);
          }),
        );
      }
    } else {
      ruleItems.push(
        renderItem(t("settings.noRules"), undefined, (setting) => {
          this.markDeclarativeRuleList(setting);
          setting.settingEl.addClass("mqtt-sync-rule-empty");
          setting.settingEl.dataset.testid = "MQTT-rule-empty";
        }),
      );
    }
    return [
      {
        type: "group",
        heading: t("settings.title"),
        cls: "mqtt-sync-settings",
        items: [
          {
            name: t("settings.enableReceiving"),
            desc: t("settings.enableReceivingDesc"),
            aliases: ["enabled", "single active writer", "单活", "启用接收"],
            control: toggle("enabled"),
          },
        ],
      },
      renderItem(t("settings.primaryConnection"), undefined, (setting) =>
        this.configurePrimaryConnectionHeading(setting, connection),
      ),
      {
        type: "group",
        heading: "",
        items: [
          {
            name: t("settings.brokerUrl"),
            desc: t("settings.brokerUrlDesc"),
            aliases: ["server", "connection", "连接"],
            control: text("brokerUrl", "mqtts://broker.example:8883"),
          },
          {
            name: t("settings.clientId"),
            desc: t("settings.clientIdDesc"),
            aliases: ["device identity", "unique", "设备身份", "唯一"],
            control: text("clientId"),
          },
          {
            name: t("settings.protocolVersion"),
            control: dropdown("protocolVersion", { "5": "MQTT 5", "4": "MQTT 3.1.1" }),
          },
          { name: t("settings.username"), control: text("username") },
          { name: t("settings.password"), control: text("password") },
          renderItem(
            t("settings.allowInsecureRemote"),
            t("settings.allowInsecureRemoteDesc"),
            (setting) => this.configureAllowInsecureRemoteSetting(setting, connection),
          ),
          renderItem(t("settings.tlsCertificates"), t("settings.tlsCertificatesDesc"), (setting) =>
            this.configureTlsSetting(setting, connection),
          ),
          { name: t("settings.keepAlive"), control: number("keepAliveSeconds") },
          {
            name: t("settings.cleanStart"),
            desc: t("settings.cleanStartDesc"),
            control: toggle("cleanStart"),
          },
          {
            name: t("settings.sessionExpiry"),
            control: { ...number("sessionExpirySeconds"), disabled: () => connection.cleanStart },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.subscription"),
        items: [
          {
            name: t("settings.topicFilter"),
            desc: t("settings.topicFilterDesc"),
            aliases: ["subscription", "wildcard", "订阅", "通配符"],
            control: text("topicFilter"),
          },
          {
            name: t("settings.requestedQos"),
            control: dropdown("subscriptionQos", qosOptions),
          },
          {
            name: t("settings.retainedDelivery"),
            control: dropdown("retainHandling", {
              "0": t("settings.retainedAlways"),
              "1": t("settings.retainedNewSubscription"),
              "2": t("settings.retainedNever"),
            }),
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.resultPublication"),
        items: [
          {
            name: t("settings.publishResults"),
            desc: t("settings.publishResultsDesc"),
            control: toggle("resultEnabled"),
          },
          {
            name: t("settings.resultTopic"),
            desc: t("settings.resultTopicDesc"),
            visible: () => Boolean(connection.result),
            control: text("resultTopic"),
          },
          {
            name: t("settings.resultQos"),
            visible: () => Boolean(connection.result),
            control: dropdown("resultQos", qosOptions),
          },
          {
            name: t("settings.retainResults"),
            desc: t("settings.retainResultsDesc"),
            visible: () => Boolean(connection.result),
            control: toggle("resultRetain"),
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.limitsAttachments"),
        items: [
          {
            name: t("settings.maxPayloadBytes"),
            desc: t("settings.maxPayloadBytesDesc"),
            control: number("maxPayloadBytes"),
          },
          {
            name: t("settings.downloadAttachments"),
            desc: t("settings.downloadAttachmentsDesc"),
            control: toggle("downloadAttachments"),
          },
          {
            name: t("settings.allowedAttachmentOrigins"),
            desc: t("settings.allowedAttachmentOriginsDesc"),
            control: text("allowedAttachmentOrigins"),
          },
        ],
      },
      renderItem(t("settings.rules"), t("settings.rulesDesc"), (setting) => {
        setting.setHeading().setClass("mqtt-sync-rules-heading");
        setting.settingEl.dataset.testid = "MQTT-rules-heading";
        this.decorateHeadingWrapper(setting, "mqtt-sync-rules-heading-items");
        setting.addButton((button) => {
          button.buttonEl.dataset.testid = "MQTT-rule-add";
          button
            .setButtonText(t("settings.addRule"))
            .setCta()
            .onClick(() => {
              new MessageDistributionRuleModal(this.app, this.plugin, undefined, () =>
                this.refreshSettings(),
              ).open();
            });
        });
      }),
      {
        type: "group",
        heading: "",
        cls: "mqtt-sync-rule-list",
        items: ruleItems,
      },
      {
        type: "group",
        heading: t("language.name"),
        items: [
          renderItem(t("language.name"), t("language.desc"), (setting) => {
            setting.settingEl.dataset.testid = "MQTT-language-setting";
            setting.addDropdown((languageDropdown) => {
              languageDropdown.selectEl.dataset.testid = "MQTT-ui-language";
              languageDropdown
                .addOptions({
                  auto: t("language.auto"),
                  en: t("language.en"),
                  "zh-CN": t("language.zhCN"),
                })
                .setValue(this.plugin.settings.uiLanguage)
                .onChange(async (value) => {
                  await this.plugin.setUiLanguage(value as UiLanguageSetting);
                  this.refreshSettings();
                });
            });
          }),
        ],
      },
    ];
  }

  override getControlValue(key: string): unknown {
    const connection = this.connection();
    const subscription = connection.subscriptions[0]!;
    const values: Record<string, unknown> = {
      enabled: this.plugin.settings.enabled,
      brokerUrl: connection.brokerUrl,
      clientId: connection.clientId,
      protocolVersion: String(connection.protocolVersion),
      username: connection.auth.username ?? "",
      password: connection.auth.password ?? "",
      keepAliveSeconds: connection.keepAliveSeconds,
      cleanStart: connection.cleanStart,
      sessionExpirySeconds: connection.sessionExpirySeconds,
      allowInsecureRemote: connection.allowInsecureRemote,
      topicFilter: subscription.filter,
      subscriptionQos: String(subscription.qos),
      retainHandling: String(subscription.retainHandling),
      resultEnabled: Boolean(connection.result),
      resultTopic: connection.result?.topic ?? "",
      resultQos: String(connection.result?.qos ?? 1),
      resultRetain: connection.result?.retain ?? false,
      maxPayloadBytes: this.plugin.settings.processing.maxPayloadBytes,
      downloadAttachments: this.plugin.settings.processing.downloadEnvelopeAttachments,
      allowedAttachmentOrigins: this.plugin.settings.processing.allowedAttachmentOrigins.join(", "),
      uiLanguage: this.plugin.settings.uiLanguage,
    };
    return values[key];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const connection = this.connection();
    const subscription = connection.subscriptions[0]!;
    switch (key) {
      case "enabled":
        this.plugin.settings.enabled = Boolean(value);
        break;
      case "brokerUrl":
        connection.brokerUrl = String(value).trim();
        break;
      case "clientId":
        connection.clientId = String(value).trim();
        break;
      case "protocolVersion":
        connection.protocolVersion = String(value) === "5" ? 5 : 4;
        break;
      case "username":
        connection.auth.username = String(value) || undefined;
        break;
      case "password":
        connection.auth.password = String(value) || undefined;
        break;
      case "keepAliveSeconds":
        connection.keepAliveSeconds = Number(value);
        break;
      case "cleanStart":
        connection.cleanStart = Boolean(value);
        if (connection.cleanStart) connection.sessionExpirySeconds = 0;
        break;
      case "sessionExpirySeconds":
        connection.sessionExpirySeconds = Number(value);
        break;
      case "allowInsecureRemote":
        connection.allowInsecureRemote = Boolean(value);
        break;
      case "topicFilter":
        subscription.filter = String(value);
        break;
      case "subscriptionQos":
        subscription.qos = Number(value) as 0 | 1 | 2;
        break;
      case "retainHandling":
        subscription.retainHandling = Number(value) as 0 | 1 | 2;
        break;
      case "resultEnabled":
        connection.result = value
          ? { topic: "obsidian/results", qos: 1, retain: false, privacy: "minimal" }
          : undefined;
        break;
      case "resultTopic":
        if (connection.result) connection.result.topic = String(value);
        break;
      case "resultQos":
        if (connection.result) connection.result.qos = Number(value) as 0 | 1 | 2;
        break;
      case "resultRetain":
        if (connection.result) connection.result.retain = Boolean(value);
        break;
      case "maxPayloadBytes":
        this.plugin.settings.processing.maxPayloadBytes = Number(value);
        break;
      case "downloadAttachments":
        this.plugin.settings.processing.downloadEnvelopeAttachments = Boolean(value);
        break;
      case "allowedAttachmentOrigins":
        this.plugin.settings.processing.allowedAttachmentOrigins = String(value)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        break;
      case "uiLanguage":
        await this.plugin.setUiLanguage(String(value) as UiLanguageSetting);
        this.update();
        return;
      default:
        throw new Error(`Unknown MQTT Sync setting key: ${key}`);
    }
    await this.plugin.saveSettings(key === "enabled");
    if (["cleanStart", "resultEnabled", "allowInsecureRemote"].includes(key)) this.update();
  }

  private async apply(): Promise<void> {
    const issues = validateSettings(this.plugin.settings);
    if (issues.length) {
      const first = issues[0]!;
      new Notice(`MQTT Sync: ${first.path}: ${localizeValidationIssue(this.plugin.i18n, first)}`);
      return;
    }
    await this.plugin.saveSettings(true);
    new Notice(this.plugin.i18n.t("notice.settingsApplied"));
  }

  override display(): void {
    const { containerEl } = this;
    const i18n = this.plugin.i18n;
    const t: I18n["t"] = (key, variables) => i18n.t(key, variables);
    containerEl.empty();
    this.decorateContainer();
    new Setting(containerEl).setName(t("settings.title")).setHeading();
    const connection = this.connection();
    new Setting(containerEl)
      .setName(t("settings.enableReceiving"))
      .setDesc(t("settings.enableReceivingDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings(true);
        }),
      );
    this.configurePrimaryConnectionHeading(new Setting(containerEl), connection);
    new Setting(containerEl)
      .setName(t("settings.brokerUrl"))
      .setDesc(t("settings.brokerUrlDesc"))
      .addText((text) =>
        text
          .setPlaceholder("mqtts://broker.example:8883")
          .setValue(connection.brokerUrl)
          .onChange((value) => {
            connection.brokerUrl = value.trim();
          }),
      );
    new Setting(containerEl)
      .setName(t("settings.clientId"))
      .setDesc(t("settings.clientIdDesc"))
      .addText((text) =>
        text.setValue(connection.clientId).onChange((value) => {
          connection.clientId = value.trim();
        }),
      );
    new Setting(containerEl).setName(t("settings.protocolVersion")).addDropdown((dropdown) =>
      dropdown
        .addOptions({ "5": "MQTT 5", "4": "MQTT 3.1.1" })
        .setValue(String(connection.protocolVersion))
        .onChange((value) => {
          connection.protocolVersion = value === "5" ? 5 : 4;
        }),
    );
    new Setting(containerEl).setName(t("settings.username")).addText((text) =>
      text.setValue(connection.auth.username ?? "").onChange((value) => {
        connection.auth.username = value || undefined;
      }),
    );
    new Setting(containerEl)
      .setName(t("settings.password"))
      .setDesc(t("settings.credentialWarning"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(connection.auth.password ?? "").onChange((value) => {
          connection.auth.password = value || undefined;
        });
      });
    this.configureAllowInsecureRemoteSetting(new Setting(containerEl), connection);
    this.configureTlsSetting(new Setting(containerEl), connection);
    new Setting(containerEl).setName(t("settings.keepAlive")).addText((text) => {
      text.inputEl.type = "number";
      text.setValue(String(connection.keepAliveSeconds)).onChange((value) => {
        connection.keepAliveSeconds = Number(value);
      });
    });
    new Setting(containerEl)
      .setName(t("settings.cleanStart"))
      .setDesc(t("settings.cleanStartDesc"))
      .addToggle((toggle) =>
        toggle.setValue(connection.cleanStart).onChange((value) => {
          connection.cleanStart = value;
          if (value) connection.sessionExpirySeconds = 0;
          this.display();
        }),
      );
    new Setting(containerEl).setName(t("settings.sessionExpiry")).addText((text) => {
      text.inputEl.type = "number";
      text
        .setDisabled(connection.cleanStart)
        .setValue(String(connection.sessionExpirySeconds))
        .onChange((value) => {
          connection.sessionExpirySeconds = Number(value);
        });
    });
    new Setting(containerEl).setName(t("settings.subscription")).setHeading();
    const subscription = connection.subscriptions[0]!;
    new Setting(containerEl)
      .setName(t("settings.topicFilter"))
      .setDesc(t("settings.topicFilterDesc"))
      .addText((text) =>
        text.setValue(subscription.filter).onChange((value) => {
          subscription.filter = value;
        }),
      );
    new Setting(containerEl).setName(t("settings.requestedQos")).addDropdown((dropdown) =>
      dropdown
        .addOptions({
          "0": t("settings.qos0"),
          "1": t("settings.qos1"),
          "2": t("settings.qos2"),
        })
        .setValue(String(subscription.qos))
        .onChange((value) => {
          subscription.qos = Number(value) as 0 | 1 | 2;
        }),
    );
    new Setting(containerEl).setName(t("settings.retainedDelivery")).addDropdown((dropdown) =>
      dropdown
        .addOptions({
          "0": t("settings.retainedAlways"),
          "1": t("settings.retainedNewSubscription"),
          "2": t("settings.retainedNever"),
        })
        .setValue(String(subscription.retainHandling))
        .onChange((value) => {
          subscription.retainHandling = Number(value) as 0 | 1 | 2;
        }),
    );
    new Setting(containerEl).setName(t("settings.resultPublication")).setHeading();
    new Setting(containerEl)
      .setName(t("settings.publishResults"))
      .setDesc(t("settings.publishResultsDesc"))
      .addToggle((toggle) =>
        toggle.setValue(Boolean(connection.result)).onChange((value) => {
          connection.result = value
            ? { topic: "obsidian/results", qos: 1, retain: false, privacy: "minimal" }
            : undefined;
          this.display();
        }),
      );
    if (connection.result)
      new Setting(containerEl)
        .setName(t("settings.resultTopic"))
        .setDesc(t("settings.resultTopicDesc"))
        .addText((text) =>
          text.setValue(connection.result!.topic).onChange((value) => {
            connection.result!.topic = value;
          }),
        );
    if (connection.result)
      new Setting(containerEl).setName(t("settings.resultQos")).addDropdown((dropdown) =>
        dropdown
          .addOptions({
            "0": t("settings.qos0"),
            "1": t("settings.qos1"),
            "2": t("settings.qos2"),
          })
          .setValue(String(connection.result!.qos))
          .onChange((value) => {
            connection.result!.qos = Number(value) as 0 | 1 | 2;
          }),
      );
    if (connection.result)
      new Setting(containerEl)
        .setName(t("settings.retainResults"))
        .setDesc(t("settings.retainResultsDesc"))
        .addToggle((toggle) =>
          toggle.setValue(connection.result!.retain).onChange((value) => {
            connection.result!.retain = value;
          }),
        );
    new Setting(containerEl).setName(t("settings.limitsAttachments")).setHeading();
    new Setting(containerEl)
      .setName(t("settings.maxPayloadBytes"))
      .setDesc(t("settings.maxPayloadBytesDesc"))
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.settings.processing.maxPayloadBytes)).onChange((value) => {
          this.plugin.settings.processing.maxPayloadBytes = Number(value);
        });
      });
    new Setting(containerEl)
      .setName(t("settings.downloadAttachments"))
      .setDesc(t("settings.downloadAttachmentsDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.processing.downloadEnvelopeAttachments)
          .onChange((value) => {
            this.plugin.settings.processing.downloadEnvelopeAttachments = value;
          }),
      );
    new Setting(containerEl)
      .setName(t("settings.allowedAttachmentOrigins"))
      .setDesc(t("settings.allowedAttachmentOriginsDesc"))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.processing.allowedAttachmentOrigins.join(", "))
          .onChange((value) => {
            this.plugin.settings.processing.allowedAttachmentOrigins = value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean);
          }),
      );
    this.renderMessageDistributionRules(containerEl);
    new Setting(containerEl)
      .setName(t("language.name"))
      .setDesc(t("language.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            auto: t("language.auto"),
            en: t("language.en"),
            "zh-CN": t("language.zhCN"),
          })
          .setValue(this.plugin.settings.uiLanguage)
          .onChange(async (value) => {
            await this.plugin.setUiLanguage(value as UiLanguageSetting);
            this.display();
          }),
      );
  }

  private decorateContainer(): void {
    this.containerEl.addClass("mqtt-sync-settings");
    this.containerEl.dataset.locale = this.plugin.i18n.locale;
  }

  private configureTlsSetting(setting: Setting, connection: ConnectionConfigV1): void {
    const t: I18n["t"] = (key, variables) => this.plugin.i18n.t(key, variables);
    setting.setName(t("settings.tlsCertificates")).setDesc(t("settings.tlsCertificatesDesc"));
    setting.settingEl.dataset.testid = "MQTT-tls-setting";
    setting.addButton((button) => {
      button.buttonEl.dataset.testid = "MQTT-tls-configure";
      button
        .setButtonText(t("settings.configure"))
        .setDisabled(connection.allowInsecureRemote)
        .setTooltip(connection.allowInsecureRemote ? t("settings.tlsCertificatesDisabled") : "")
        .onClick(() => {
          new TlsCertificateModal(this.app, this.plugin.i18n, connection.tls, async (tls) => {
            connection.tls = tls;
            await this.plugin.saveSettings(false);
            this.refreshSettings();
          }).open();
        });
    });
  }

  private configureAllowInsecureRemoteSetting(
    setting: Setting,
    connection: ConnectionConfigV1,
  ): void {
    const t: I18n["t"] = (key, variables) => this.plugin.i18n.t(key, variables);
    setting
      .setName(t("settings.allowInsecureRemote"))
      .setDesc(t("settings.allowInsecureRemoteDesc"));
    setting.settingEl.dataset.testid = "MQTT-allow-insecure-remote-setting";
    setting.addToggle((toggle) =>
      toggle.setValue(connection.allowInsecureRemote).onChange((value) => {
        connection.allowInsecureRemote = value;
        this.refreshSettings();
      }),
    );
  }

  private configurePrimaryConnectionHeading(
    setting: Setting,
    connection: ConnectionConfigV1,
  ): void {
    const t: I18n["t"] = (key, variables) => this.plugin.i18n.t(key, variables);
    setting
      .setName(t("settings.primaryConnection"))
      .setHeading()
      .setClass("mqtt-sync-primary-heading");
    setting.settingEl.dataset.testid = "MQTT-primary-connection-heading";
    this.decorateHeadingWrapper(setting, "mqtt-sync-primary-heading-items");
    setting.addButton((button) => {
      button.buttonEl.dataset.testid = "MQTT-test-connection";
      button
        .setButtonText(t("settings.testConnection"))
        .setTooltip(t("settings.testConnectionDesc"))
        .onClick(async () => {
          button.setDisabled(true);
          try {
            const connectionIssues = validateSettings(this.plugin.settings).filter((issue) =>
              issue.path.startsWith("connections[0]"),
            );
            if (connectionIssues.length) {
              const first = connectionIssues[0]!;
              new Notice(
                `MQTT Sync: ${first.path}: ${localizeValidationIssue(this.plugin.i18n, first)}`,
              );
              return;
            }
            await this.plugin.testConnection(connection);
            new Notice(t("notice.connectionTestSucceeded"));
          } catch {
            new Notice(t("notice.connectionTestFailed"));
          } finally {
            button.setDisabled(false);
          }
        });
    });
    setting.addButton((button) => {
      button.buttonEl.dataset.testid = "MQTT-apply";
      button
        .setButtonText(t("settings.apply"))
        .setCta()
        .onClick(() => void this.apply());
    });
  }

  private refreshSettings(): void {
    const update = (this as unknown as { update?: () => void }).update;
    if (typeof update === "function") {
      update.call(this);
      return;
    }
    this.display();
  }

  private decorateHeadingWrapper(setting: Setting, className: string): void {
    const settingItems = setting.settingEl.parentElement;
    if (settingItems?.classList.contains("setting-items")) settingItems.addClass(className);
  }

  private markDeclarativeRuleList(setting: Setting): void {
    const list = setting.settingEl.closest<HTMLElement>(".mqtt-sync-rule-list");
    if (list) list.dataset.testid = "MQTT-rule-list";
  }

  private renderMessageDistributionRules(containerEl: HTMLElement): void {
    const i18n = this.plugin.i18n;
    const t: I18n["t"] = (key, variables) => i18n.t(key, variables);
    const heading = new Setting(containerEl)
      .setName(t("settings.rules"))
      .setDesc(t("settings.rulesDesc"))
      .setHeading()
      .setClass("mqtt-sync-rules-heading");
    heading.settingEl.dataset.testid = "MQTT-rules-heading";
    this.decorateHeadingWrapper(heading, "mqtt-sync-rules-heading-items");
    heading.addButton((button) => {
      button.buttonEl.dataset.testid = "MQTT-rule-add";
      button
        .setButtonText(t("settings.addRule"))
        .setCta()
        .onClick(() => {
          new MessageDistributionRuleModal(this.app, this.plugin, undefined, () =>
            this.refreshSettings(),
          ).open();
        });
    });

    const list = containerEl.createDiv({ cls: "mqtt-sync-rule-list" });
    list.dataset.testid = "MQTT-rule-list";
    const rules = rulesOf(this.plugin);
    if (!rules.length) {
      const empty = list.createDiv({
        cls: "mqtt-sync-rule-empty",
        text: t("settings.noRules"),
      });
      empty.dataset.testid = "MQTT-rule-empty";
    }
    rules.forEach((rule, index) => this.renderRule(list, rule, index));
  }

  private renderRule(containerEl: HTMLElement, rule: RuleV1, index: number): void {
    this.configureRuleSetting(new Setting(containerEl), rule, index);
  }

  private configureRuleSetting(setting: Setting, rule: RuleV1, index: number): void {
    const i18n = this.plugin.i18n;
    const t: I18n["t"] = (key, variables) => i18n.t(key, variables);
    const info = summarizeRule(rule, i18n);
    setting.setDesc(info.description).setClass("mqtt-sync-rule-card");
    setting.nameEl.empty();
    setting.nameEl.addClass("mqtt-sync-rule-card-heading");
    const name = setting.nameEl.createSpan({
      cls: "mqtt-sync-rule-card-name",
      text: info.name,
    });
    name.dataset.testid = `MQTT-rule-name-${index}`;
    const notePath = setting.nameEl.createSpan({
      cls: "mqtt-sync-rule-card-note-path",
      text: t("settings.notePath", { path: info.notePath }),
      attr: { title: t("settings.notePath", { path: info.notePath }) },
    });
    notePath.dataset.testid = `MQTT-rule-note-path-${index}`;
    setting.settingEl.dataset.testid = `MQTT-rule-card-${index}`;
    setting.settingEl.dataset.ruleId = rule.id;
    setting.settingEl.toggleClass("is-disabled", !rule.enabled);

    setting.addToggle((toggle) => {
      toggle.toggleEl.dataset.testid = `MQTT-rule-enabled-${index}`;
      toggle
        .setTooltip(t(rule.enabled ? "settings.disableRule" : "settings.enableRule"))
        .setValue(rule.enabled)
        .onChange(async (enabled) => {
          const draft = structuredClone(rule);
          draft.enabled = enabled;
          this.plugin.settings.rules.rules = saveRuleDraft(rulesOf(this.plugin), draft, index);
          await this.plugin.saveSettings(false);
          this.refreshSettings();
        });
    });
    setting.addExtraButton((button) => {
      button.extraSettingsEl.dataset.testid = `MQTT-rule-up-${index}`;
      button
        .setIcon("chevron-up")
        .setTooltip(t("settings.moveUp"))
        .setDisabled(index === 0)
        .onClick(async () => {
          this.plugin.settings.rules.rules = moveRule(rulesOf(this.plugin), index, index - 1);
          await this.plugin.saveSettings(false);
          this.refreshSettings();
        });
    });
    setting.addExtraButton((button) => {
      button.extraSettingsEl.dataset.testid = `MQTT-rule-down-${index}`;
      button
        .setIcon("chevron-down")
        .setTooltip(t("settings.moveDown"))
        .setDisabled(index === rulesOf(this.plugin).length - 1)
        .onClick(async () => {
          this.plugin.settings.rules.rules = moveRule(rulesOf(this.plugin), index, index + 1);
          await this.plugin.saveSettings(false);
          this.refreshSettings();
        });
    });
    setting.addExtraButton((button) => {
      button.extraSettingsEl.dataset.testid = `MQTT-rule-edit-${index}`;
      button
        .setIcon("pencil")
        .setTooltip(t("settings.edit"))
        .onClick(() => {
          new MessageDistributionRuleModal(this.app, this.plugin, index, () =>
            this.refreshSettings(),
          ).open();
        });
    });
    setting.addExtraButton((button) => {
      let confirming = false;
      button.extraSettingsEl.dataset.testid = `MQTT-rule-delete-${index}`;
      button
        .setIcon("trash-2")
        .setTooltip(t("settings.delete"))
        .onClick(async () => {
          if (!confirming) {
            confirming = true;
            button.extraSettingsEl.dataset.confirming = "true";
            button.setIcon("check").setTooltip(t("settings.confirmDelete"));
            new Notice(t("notice.confirmDelete", { name: rule.name }));
            return;
          }
          this.plugin.settings.rules.rules = removeRule(rulesOf(this.plugin), index);
          await this.plugin.saveSettings(false);
          this.refreshSettings();
        });
    });
  }
}

function rulesOf(plugin: MQTTSyncPlugin): RuleV1[] {
  return plugin.settings.rules.rules;
}
