import {
  AbstractInputSuggest,
  Modal,
  Notice,
  Setting,
  type App,
  type SearchComponent,
  type TFile,
} from "obsidian";
import type MQTTSyncPlugin from "../main";
import type { ConditionV1, RuleV1 } from "../domain/types";
import { conditionFieldLabel, localizeValidationIssue, type I18n } from "../i18n";
import { validateRules } from "../settings/validate";
import {
  CONDITION_FIELDS,
  createBlankRule,
  createCondition,
  mimeTypePresets,
  operatorLabelForField,
  operatorsForField,
  saveRuleDraft,
  type ConditionField,
  type MimeTypePreset,
} from "../settings/rule-editor";

class VaultPathSuggest extends AbstractInputSuggest<TFile> {
  constructor(
    app: App,
    private readonly inputEl: HTMLInputElement,
    private readonly files: () => TFile[],
  ) {
    super(app, inputEl);
    this.limit = 50;
  }

  protected getSuggestions(query: string): TFile[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return this.files()
      .filter((file) => file.path.toLocaleLowerCase().includes(normalizedQuery))
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, this.limit);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  override selectSuggestion(file: TFile): void {
    this.inputEl.value = file.path;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
  }
}

class MimeTypeSuggest extends AbstractInputSuggest<MimeTypePreset> {
  constructor(
    app: App,
    private readonly inputEl: HTMLInputElement,
    private readonly operator: () => "equals" | "startsWith",
    private readonly i18n: I18n,
  ) {
    super(app, inputEl);
    this.limit = 30;
  }

  protected getSuggestions(query: string): MimeTypePreset[] {
    return [...mimeTypePresets(this.operator(), query, this.i18n)];
  }

  renderSuggestion(preset: MimeTypePreset, el: HTMLElement): void {
    el.addClass("mqtt-sync-mime-suggestion");
    el.dataset.testid = "MQTT-rule-mime-suggestion";
    el.dataset.mimeValue = preset.value;
    this.constrainPopover(el);
    el.createDiv({ cls: "mqtt-sync-mime-suggestion-label", text: preset.label });
    const valueEl = el.createDiv({ cls: "mqtt-sync-mime-suggestion-value", text: preset.value });
    valueEl.setAttr("title", preset.value);
  }

  override selectSuggestion(preset: MimeTypePreset): void {
    this.inputEl.value = preset.value;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
  }

  private constrainPopover(suggestionEl: HTMLElement): void {
    const popover = suggestionEl.closest<HTMLElement>(".suggestion-container");
    const search = this.inputEl.closest<HTMLElement>(".search-input-container");
    const modal = this.inputEl.closest<HTMLElement>(".modal");
    if (!popover || !search || !modal) return;
    popover.addClass("mqtt-sync-mime-suggestion-container");
    const searchRect = search.getBoundingClientRect();
    const modalRect = modal.getBoundingClientRect();
    const width = Math.max(0, Math.min(searchRect.width, modalRect.right - searchRect.left));
    popover.setCssStyles({
      width: `${width}px`,
      minWidth: `${width}px`,
      maxWidth: `${width}px`,
    });
    queueMicrotask(() => this.positionPopover(popover, search, modal));
  }

  private positionPopover(popover: HTMLElement, search: HTMLElement, modal: HTMLElement): void {
    if (!popover.isConnected || !search.isConnected || !modal.isConnected) return;
    const searchRect = search.getBoundingClientRect();
    const modalRect = modal.getBoundingClientRect();
    const spaceAbove = Math.max(0, searchRect.top - modalRect.top);
    const spaceBelow = Math.max(0, modalRect.bottom - searchRect.bottom);
    const openAbove = spaceAbove > spaceBelow;
    const availableHeight = openAbove ? spaceAbove : spaceBelow;
    popover.dataset.placement = openAbove ? "above" : "below";
    popover.setCssStyles({ maxHeight: `${availableHeight}px`, bottom: "auto" });

    const popoverRect = popover.getBoundingClientRect();
    const targetTop = openAbove
      ? Math.max(modalRect.top, searchRect.top - popoverRect.height)
      : searchRect.bottom;
    const currentTop = Number.parseFloat(popover.style.top || getComputedStyle(popover).top);
    if (Number.isFinite(currentTop)) {
      popover.setCssStyles({ top: `${currentTop + targetTop - popoverRect.top}px` });
    }
  }
}

export class MessageDistributionRuleModal extends Modal {
  private readonly original?: RuleV1;
  private readonly draft: RuleV1;
  private validationEl?: HTMLElement;
  private pathSuggesters: VaultPathSuggest[] = [];
  private mimeSuggesters: MimeTypeSuggest[] = [];

  constructor(
    app: App,
    private readonly plugin: MQTTSyncPlugin,
    private readonly ruleIndex: number | undefined,
    private readonly onSaved: () => void,
  ) {
    super(app);
    this.original = ruleIndex === undefined ? undefined : plugin.settings.rules.rules[ruleIndex];
    this.draft = this.original
      ? structuredClone(this.original)
      : createBlankRule(
          plugin.settings.rules.rules.map((rule) => rule.id),
          Object.keys(plugin.settings.templates.entries),
          plugin.i18n.t("rule.newName"),
        );
  }

  override onOpen(): void {
    this.modalEl.addClass("mqtt-sync-rule-modal");
    this.modalEl.dataset.testid = "MQTT-rule-modal";
    this.render();
  }

  override onClose(): void {
    this.closeInputSuggesters();
    this.contentEl.empty();
  }

  private render(): void {
    const i18n = this.plugin.i18n;
    const t: I18n["t"] = (key, variables) => i18n.t(key, variables);
    this.closeInputSuggesters();
    this.contentEl.empty();
    this.modalEl.dataset.locale = i18n.locale;
    this.titleEl.setText(t(this.original ? "rule.editTitle" : "rule.addTitle"));

    new Setting(this.contentEl)
      .setName(t("rule.name"))
      .setDesc(t("rule.nameDesc"))
      .setClass("mqtt-sync-rule-identity")
      .addText((text) => {
        text.inputEl.dataset.testid = "MQTT-rule-name";
        text.inputEl.addClass("mqtt-sync-rule-name-input");
        text.setValue(this.draft.name).onChange((value) => {
          this.draft.name = value;
        });
      })
      .addToggle((toggle) => {
        toggle.toggleEl.dataset.testid = "MQTT-rule-enabled";
        toggle
          .setTooltip(t("rule.enabled"))
          .setValue(this.draft.enabled)
          .onChange((value) => {
            this.draft.enabled = value;
          });
      });

    const conditionHeading = new Setting(this.contentEl)
      .setName(t("rule.conditions"))
      .setDesc(t(this.draft.when.all.length ? "rule.conditionsDesc" : "rule.noConditionsDesc"))
      .setClass("mqtt-sync-rule-conditions-heading");
    conditionHeading.settingEl.dataset.testid = "MQTT-rule-conditions";
    conditionHeading.addButton((button) => {
      button.buttonEl.dataset.testid = "MQTT-rule-add-condition";
      button
        .setButtonText(t("rule.addCondition"))
        .setCta()
        .onClick(() => {
          this.draft.when.all.push(createCondition());
          this.render();
        });
    });

    this.draft.when.all.forEach((condition, index) => this.renderCondition(condition, index));

    new Setting(this.contentEl)
      .setName(t("rule.notePathTemplate"))
      .setDesc(t("rule.notePathDesc"))
      .setClass("mqtt-sync-rule-path-setting")
      .addSearch((search) => {
        this.configurePathSearch(
          search,
          "note-path",
          this.draft.action.notePathTemplate,
          () => this.app.vault.getMarkdownFiles(),
          (value) => {
            this.draft.action.notePathTemplate = value.trim();
          },
        );
      });

    new Setting(this.contentEl)
      .setName(t("rule.contentTemplate"))
      .setDesc(t("rule.contentTemplateDesc"))
      .addDropdown((dropdown) => {
        dropdown.selectEl.dataset.testid = "MQTT-rule-template";
        const entries = Object.keys(this.plugin.settings.templates.entries);
        for (const id of entries) dropdown.addOption(id, id);
        dropdown.setValue(this.draft.action.contentTemplateId).onChange((value) => {
          this.draft.action.contentTemplateId = value;
        });
      });

    new Setting(this.contentEl)
      .setName(t("rule.insertionMode"))
      .setDesc(t("rule.insertionModeDesc"))
      .addDropdown((dropdown) => {
        dropdown.selectEl.dataset.testid = "MQTT-rule-insertion";
        dropdown
          .addOptions({
            append: t("rule.insertionAppend"),
            prepend: t("rule.insertionPrepend"),
            "after-heading": t("rule.insertionAfterHeading"),
          })
          .setValue(this.draft.action.insertion)
          .onChange((value) => {
            this.draft.action.insertion = value as RuleV1["action"]["insertion"];
            if (value !== "after-heading") delete this.draft.action.heading;
            this.render();
          });
      });

    if (this.draft.action.insertion === "after-heading") {
      new Setting(this.contentEl)
        .setName(t("rule.heading"))
        .setDesc(t("rule.headingDesc"))
        .addText((text) => {
          text.inputEl.dataset.testid = "MQTT-rule-heading";
          text
            .setPlaceholder("### Log")
            .setValue(this.draft.action.heading ?? "")
            .onChange((value) => {
              this.draft.action.heading = value;
            });
        });
    }

    new Setting(this.contentEl)
      .setName(t("rule.attachmentPathTemplate"))
      .setDesc(t("rule.attachmentPathDesc"))
      .setClass("mqtt-sync-rule-path-setting")
      .addSearch((search) => {
        this.configurePathSearch(
          search,
          "attachment-path",
          this.draft.action.attachmentPathTemplate ?? "",
          () => this.app.vault.getFiles(),
          (value) => {
            const trimmed = value.trim();
            if (trimmed) this.draft.action.attachmentPathTemplate = trimmed;
            else delete this.draft.action.attachmentPathTemplate;
          },
        );
      });

    this.validationEl = this.contentEl.createDiv({ cls: "mqtt-sync-rule-validation" });
    this.validationEl.dataset.testid = "MQTT-rule-validation";
    this.validationEl.setAttr("role", "alert");

    const footer = new Setting(this.contentEl).setClass("mqtt-sync-rule-modal-footer");
    footer.addButton((button) => {
      button.buttonEl.dataset.testid = "MQTT-rule-save";
      button
        .setButtonText(t("rule.save"))
        .setCta()
        .onClick(() => void this.save());
    });
    footer.addButton((button) => {
      button.buttonEl.dataset.testid = "MQTT-rule-cancel";
      button.setButtonText(t("rule.cancel")).onClick(() => this.close());
    });
  }

  private configurePathSearch(
    search: SearchComponent,
    testId: "note-path" | "attachment-path",
    value: string,
    files: () => TFile[],
    onChange: (value: string) => void,
  ): void {
    search.inputEl.dataset.testid = `MQTT-rule-${testId}`;
    search.inputEl.addClass("mqtt-sync-rule-path-input");
    search.clearButtonEl.dataset.testid = `MQTT-rule-${testId}-clear`;
    const container = search.inputEl.closest<HTMLElement>(".search-input-container");
    if (container) {
      container.addClass("mqtt-sync-rule-path-search");
      container.dataset.testid = `MQTT-rule-${testId}-search`;
    }
    search.setValue(value).onChange(onChange);
    this.pathSuggesters.push(new VaultPathSuggest(this.app, search.inputEl, files));
  }

  private closeInputSuggesters(): void {
    for (const suggester of this.pathSuggesters) suggester.close();
    this.pathSuggesters = [];
    for (const suggester of this.mimeSuggesters) suggester.close();
    this.mimeSuggesters = [];
  }

  private configureMimeSearch(search: SearchComponent, index: number, value: string): void {
    search.inputEl.dataset.testid = `MQTT-rule-condition-value-${index}`;
    search.inputEl.addClass("mqtt-sync-rule-mime-input");
    search.inputEl.setAttribute("aria-label", this.plugin.i18n.t("rule.mimeAria"));
    search.clearButtonEl.dataset.testid = `MQTT-rule-condition-mime-clear-${index}`;
    const container = search.inputEl.closest<HTMLElement>(".search-input-container");
    if (container) {
      container.addClass("mqtt-sync-rule-mime-search");
      container.dataset.testid = `MQTT-rule-condition-mime-search-${index}`;
    }
    search
      .setPlaceholder(this.plugin.i18n.t("rule.mimePlaceholder"))
      .setValue(value)
      .onChange((nextValue) => {
        const current = this.draft.when.all[index];
        if (current?.field === "attachmentMime") {
          this.draft.when.all[index] = { ...current, value: nextValue };
        }
      });
    const suggester = new MimeTypeSuggest(
      this.app,
      search.inputEl,
      () => {
        const current = this.draft.when.all[index];
        return current?.field === "attachmentMime" ? current.op : "equals";
      },
      this.plugin.i18n,
    );
    const requestSuggestions = (): void => {
      search.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    };
    search.inputEl.addEventListener("focus", requestSuggestions);
    search.inputEl.addEventListener("click", requestSuggestions);
    search.clearButtonEl.addEventListener("click", () => {
      queueMicrotask(() => {
        search.inputEl.focus();
        requestSuggestions();
      });
    });
    this.mimeSuggesters.push(suggester);
  }

  private renderCondition(condition: ConditionV1, index: number): void {
    const setting = new Setting(this.contentEl).setClass("mqtt-sync-rule-condition");
    setting.settingEl.dataset.testid = `MQTT-rule-condition-${index}`;
    const i18n = this.plugin.i18n;
    setting.setName(i18n.t("rule.condition", { number: index + 1 }));
    setting.addDropdown((dropdown) => {
      dropdown.selectEl.dataset.testid = `MQTT-rule-condition-field-${index}`;
      for (const field of CONDITION_FIELDS) {
        dropdown.addOption(field, conditionFieldLabel(i18n, field));
      }
      dropdown.setValue(condition.field).onChange((value) => {
        this.draft.when.all[index] = createCondition(value as ConditionField);
        this.render();
      });
    });
    setting.addDropdown((dropdown) => {
      dropdown.selectEl.dataset.testid = `MQTT-rule-condition-op-${index}`;
      for (const operator of operatorsForField(condition.field)) {
        dropdown.addOption(operator, operatorLabelForField(condition.field, operator, i18n));
      }
      dropdown.setValue(condition.op).onChange((value) => {
        const current = this.draft.when.all[index];
        if (current) this.draft.when.all[index] = { ...current, op: value } as ConditionV1;
      });
    });
    if (
      condition.field === "hasAttachment" ||
      condition.field === "hasHttpUrl" ||
      condition.field === "retain" ||
      condition.field === "duplicate" ||
      condition.field === "hasCorrelationData"
    ) {
      setting.addDropdown((dropdown) => {
        dropdown.selectEl.dataset.testid = `MQTT-rule-condition-value-${index}`;
        dropdown
          .addOptions({ true: i18n.t("rule.yes"), false: i18n.t("rule.no") })
          .setValue(String(condition.value))
          .onChange((value) => {
            const current = this.draft.when.all[index];
            if (
              current?.field === "hasAttachment" ||
              current?.field === "hasHttpUrl" ||
              current?.field === "retain" ||
              current?.field === "duplicate" ||
              current?.field === "hasCorrelationData"
            ) {
              this.draft.when.all[index] = { ...current, value: value === "true" };
            }
          });
      });
    } else if (condition.field === "priority" || condition.field === "qos") {
      setting.addDropdown((dropdown) => {
        dropdown.selectEl.dataset.testid = `MQTT-rule-condition-value-${index}`;
        dropdown
          .addOptions(
            condition.field === "qos"
              ? { "0": "0", "1": "1", "2": "2" }
              : { "1": "1", "2": "2", "3": "3", "4": "4", "5": "5" },
          )
          .setValue(String(condition.value))
          .onChange((value) => {
            const current = this.draft.when.all[index];
            if (current?.field === "priority" || current?.field === "qos") {
              this.draft.when.all[index] = { ...current, value: Number(value) };
            }
          });
      });
    } else if (condition.field === "attachmentMime") {
      setting.addSearch((search) => {
        this.configureMimeSearch(search, index, condition.value);
      });
    } else {
      setting.addText((text) => {
        text.inputEl.dataset.testid = `MQTT-rule-condition-value-${index}`;
        text.setValue(String(condition.value)).onChange((value) => {
          const current = this.draft.when.all[index];
          if (current) this.draft.when.all[index] = { ...current, value } as ConditionV1;
        });
      });
    }
    setting.addExtraButton((button) => {
      button.extraSettingsEl.dataset.testid = `MQTT-rule-condition-delete-${index}`;
      button
        .setIcon("trash-2")
        .setTooltip(i18n.t("rule.deleteCondition"))
        .onClick(() => {
          this.draft.when.all.splice(index, 1);
          this.render();
        });
    });
  }

  private async save(): Promise<void> {
    const candidate = structuredClone(this.plugin.settings);
    candidate.rules.rules = saveRuleDraft(
      this.plugin.settings.rules.rules,
      this.draft,
      this.ruleIndex,
    );
    const issues = validateRules(candidate.rules, candidate.templates);
    if (issues.length) {
      const first = issues[0];
      if (first) {
        this.validationEl?.setText(
          `${first.path}: ${localizeValidationIssue(this.plugin.i18n, first)}`,
        );
      }
      return;
    }

    this.plugin.settings.rules = candidate.rules;
    await this.plugin.saveSettings(false);
    new Notice(
      this.plugin.i18n.t(this.original ? "notice.ruleUpdated" : "notice.ruleAdded", {
        name: this.draft.name,
      }),
    );
    this.onSaved();
    this.close();
  }
}
