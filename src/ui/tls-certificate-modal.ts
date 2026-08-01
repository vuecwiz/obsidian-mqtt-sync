import { Modal, Setting, type App } from "obsidian";
import type { MqttTlsConfig } from "../domain/types";
import type { I18n } from "../i18n";
import { normalizedTlsConfig, validateTlsConfig } from "../settings/tls";

export class TlsCertificateModal extends Modal {
  private readonly draft: MqttTlsConfig;
  private validationEl?: HTMLElement;

  constructor(
    app: App,
    private readonly i18n: I18n,
    current: MqttTlsConfig,
    private readonly onSave: (tls: MqttTlsConfig) => Promise<void>,
  ) {
    super(app);
    this.draft = structuredClone(current);
  }

  override onOpen(): void {
    this.modalEl.addClass("mqtt-sync-tls-modal");
    this.modalEl.dataset.testid = "MQTT-tls-modal";
    this.modalEl.dataset.locale = this.i18n.locale;
    this.titleEl.setText(this.i18n.t("tls.title"));
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const t: I18n["t"] = (key, variables) => this.i18n.t(key, variables);
    this.contentEl.empty();
    const warning = this.contentEl.createDiv({ cls: "mqtt-sync-tls-warning", text: t("tls.desc") });
    warning.setAttr("role", "note");

    this.addPemSetting("ca", t("settings.tlsCa"), t("settings.tlsCaDesc"), this.draft.caPem ?? "");
    this.addPemSetting(
      "client-certificate",
      t("settings.tlsClientCertificate"),
      undefined,
      this.draft.clientCertificatePem ?? "",
    );
    this.addPemSetting(
      "private-key",
      t("settings.tlsPrivateKey"),
      t("settings.tlsPrivateKeyDesc"),
      this.draft.privateKeyPem ?? "",
    );

    this.validationEl = this.contentEl.createDiv({ cls: "mqtt-sync-tls-validation" });
    this.validationEl.dataset.testid = "MQTT-tls-validation";
    this.validationEl.setAttr("role", "alert");

    const footer = new Setting(this.contentEl).setClass("mqtt-sync-tls-modal-footer");
    footer.addButton((button) => {
      button.buttonEl.dataset.testid = "MQTT-tls-save";
      button
        .setButtonText(t("tls.save"))
        .setCta()
        .onClick(() => void this.save());
    });
    footer.addButton((button) => {
      button.buttonEl.dataset.testid = "MQTT-tls-cancel";
      button.setButtonText(t("tls.cancel")).onClick(() => this.close());
    });
  }

  private addPemSetting(
    field: "ca" | "client-certificate" | "private-key",
    name: string,
    description: string | undefined,
    value: string,
  ): void {
    const setting = new Setting(this.contentEl).setName(name).setClass("mqtt-sync-tls-pem-setting");
    if (description) setting.setDesc(description);
    setting.addTextArea((text) => {
      text.inputEl.dataset.testid = `MQTT-tls-${field}`;
      text.inputEl.addClass("mqtt-sync-tls-pem-input");
      text.inputEl.rows = 6;
      if (field === "private-key") text.inputEl.addClass("mqtt-sync-secret");
      text.inputEl.spellcheck = false;
      text.inputEl.setAttribute("autocomplete", "off");
      text.setValue(value).onChange((next) => {
        const normalized = next.trim() || undefined;
        if (field === "ca") this.draft.caPem = normalized;
        else if (field === "client-certificate") this.draft.clientCertificatePem = normalized;
        else this.draft.privateKeyPem = normalized;
      });
    });
  }

  private async save(): Promise<void> {
    if (validateTlsConfig(this.draft) === "CLIENT_PAIR") {
      this.validationEl?.setText(this.i18n.t("tls.clientPairRequired"));
      return;
    }
    await this.onSave(normalizedTlsConfig(this.draft));
    this.close();
  }
}
