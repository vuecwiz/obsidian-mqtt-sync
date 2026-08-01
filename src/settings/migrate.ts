import type { PersistedSettingsV1 } from "../domain/types";
import { createDefaultSettings } from "./defaults";

export function migrateSettings(raw: unknown): PersistedSettingsV1 {
  const defaults = createDefaultSettings();
  if (!raw || typeof raw !== "object") return defaults;
  const data = raw as Partial<PersistedSettingsV1> & { connections?: unknown[] };
  if (
    data.schemaVersion !== 1 ||
    !Array.isArray(data.connections) ||
    data.connections.some((item) => !item || typeof item !== "object" || !("brokerUrl" in item))
  )
    return defaults;
  return {
    ...defaults,
    ...data,
    schemaVersion: 1,
    uiLanguage: data.uiLanguage === "en" || data.uiLanguage === "zh-CN" ? data.uiLanguage : "auto",
    device: { ...defaults.device, ...data.device },
    connections: data.connections as PersistedSettingsV1["connections"],
    rules: data.rules?.schemaVersion === 1 ? data.rules : defaults.rules,
    templates: data.templates?.schemaVersion === 1 ? data.templates : defaults.templates,
    processing: { ...defaults.processing, ...data.processing },
    diagnostics: { ...defaults.diagnostics, ...data.diagnostics },
  };
}
