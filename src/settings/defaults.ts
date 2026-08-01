import { randomUUID } from "node:crypto";
import type { PersistedSettingsV1, RuleSetV1, TemplateCatalogV1 } from "../domain/types";

export const DEFAULT_TEMPLATES: TemplateCatalogV1 = {
  schemaVersion: 1,
  entries: { inbox: "{{payload}}" },
};
export const DEFAULT_RULES: RuleSetV1 = {
  schemaVersion: 1,
  matchMode: "first",
  rules: [
    {
      id: "inbox",
      revision: 1,
      name: "Inbox",
      enabled: true,
      when: { all: [] },
      action: {
        notePathTemplate: "MQTT Sync/Inbox.md",
        contentTemplateId: "inbox",
        insertion: "append",
      },
    },
  ],
};

export function createDefaultSettings(): PersistedSettingsV1 {
  const deviceId = randomUUID();
  return {
    schemaVersion: 1,
    uiLanguage: "auto",
    enabled: false,
    device: { deviceId, writerDeviceId: deviceId },
    connections: [],
    rules: structuredClone(DEFAULT_RULES),
    templates: structuredClone(DEFAULT_TEMPLATES),
    processing: {
      dedupeWindowSeconds: 600,
      maxPayloadBytes: 256 * 1024,
      maxAttachmentBytes: 15 * 1024 * 1024,
      attachmentTimeoutMs: 30_000,
      allowedAttachmentOrigins: [],
      maxAttempts: 8,
      concurrency: 2,
      completedRetentionDays: 7,
      completedRetentionCount: 10_000,
      downloadEnvelopeAttachments: false,
    },
    diagnostics: { logLevel: "info", redactBodies: true },
  };
}
