import type { ConnectionConfigV1 } from "../../src/domain/types";
import { createDefaultSettings } from "../../src/settings/defaults";
import { migrateSettings } from "../../src/settings/migrate";
import { validateRules, validateSettings } from "../../src/settings/validate";

function connection(): ConnectionConfigV1 {
  return {
    id: "primary",
    name: "Primary",
    brokerUrl: "mqtts://broker.example:8883",
    protocolVersion: 5,
    clientId: "settings-validation-client",
    auth: {},
    tls: {},
    allowInsecureRemote: false,
    keepAliveSeconds: 60,
    connectTimeoutMs: 30_000,
    cleanStart: false,
    sessionExpirySeconds: 86_400,
    subscriptions: [
      {
        filter: "devices/+/state",
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

function configuredSettings() {
  const settings = createDefaultSettings();
  settings.connections = [connection()];
  return settings;
}

function codes(value: unknown): string[] {
  return validateSettings(value).map((entry) => entry.code);
}

describe("settings validation policy", () => {
  it("accepts a complete secure configuration", () => {
    expect(validateSettings(configuredSettings())).toEqual([]);
  });

  it("validates rule edits independently of an unconfigured broker", () => {
    const settings = createDefaultSettings();
    settings.connections = [connection()];
    settings.connections[0]!.clientId = "";
    expect(validateSettings(settings).map((entry) => entry.path)).toContain(
      "connections[0].clientId",
    );
    expect(validateRules(settings.rules, settings.templates)).toEqual([]);

    settings.rules.rules[0]!.action.notePathTemplate = "../outside.md";
    expect(validateRules(settings.rules, settings.templates).map((entry) => entry.code)).toContain(
      "PATH",
    );
  });

  it("rejects malformed root, locale, device and diagnostics structures", () => {
    expect(codes(null)).toEqual(["TYPE"]);
    const settings = configuredSettings() as unknown as Record<string, unknown>;
    settings.schemaVersion = 2;
    settings.uiLanguage = "fr";
    settings.device = { deviceId: 1 };
    settings.diagnostics = { logLevel: "trace", redactBodies: "yes" };
    expect(codes(settings)).toEqual(
      expect.arrayContaining(["SCHEMA", "LANGUAGE", "DEVICE", "TYPE"]),
    );
  });

  it("requires explicit opt-in for plain remote transport and rejects URL credentials or query data", () => {
    const settings = configuredSettings();
    const value = settings.connections[0]!;
    value.brokerUrl = "mqtt://broker.example:1883";
    expect(codes(settings)).toContain("BROKER_URL");
    value.allowInsecureRemote = true;
    expect(codes(settings)).not.toContain("BROKER_URL");
    value.brokerUrl = "mqtt://user:password@broker.example:1883?token=secret";
    expect(codes(settings)).toContain("BROKER_URL");
  });

  it("validates TLS client pairs, session constraints, reconnect bounds and subscriptions", () => {
    const settings = configuredSettings();
    const value = settings.connections[0]!;
    value.tls.clientCertificatePem = "certificate";
    value.cleanStart = true;
    value.sessionExpirySeconds = 1;
    value.reconnect = { minMs: 5_000, maxMs: 1_000, jitterRatio: 1 };
    value.subscriptions[0]!.filter = "bad/#/filter";
    expect(codes(settings)).toEqual(
      expect.arrayContaining(["TLS_CLIENT_PAIR", "SESSION", "RANGE", "SUBSCRIPTION"]),
    );
  });

  it("validates result topics and detects loops only through enabled subscriptions", () => {
    const settings = configuredSettings();
    const value = settings.connections[0]!;
    value.result = { topic: "devices/a/state", qos: 1, retain: false, privacy: "minimal" };
    expect(codes(settings)).toContain("RESULT_LOOP");
    value.subscriptions[0]!.enabled = false;
    expect(codes(settings)).not.toContain("RESULT_LOOP");
    value.result = { topic: "bad/+", qos: 1, retain: false, privacy: "minimal" };
    (value.result as unknown as { qos: number }).qos = 3;
    expect(codes(settings)).toContain("RESULT_TOPIC");
  });

  it("enforces payload, attachment and exact HTTPS-origin limits", () => {
    const settings = configuredSettings();
    settings.processing.maxPayloadBytes = 1024 * 1024 + 1;
    settings.processing.maxAttachmentBytes = 100 * 1024 * 1024 + 1;
    settings.processing.allowedAttachmentOrigins = [
      "http://files.example",
      "https://files.example/path",
    ];
    expect(codes(settings)).toEqual(expect.arrayContaining(["RANGE", "ATTACHMENT_ORIGIN"]));
    settings.processing.maxPayloadBytes = 256 * 1024;
    settings.processing.maxAttachmentBytes = 15 * 1024 * 1024;
    settings.processing.allowedAttachmentOrigins = ["https://files.example"];
    expect(codes(settings)).not.toContain("RANGE");
    expect(codes(settings)).not.toContain("ATTACHMENT_ORIGIN");
  });

  it("rejects unknown template variables and unsafe rule paths", () => {
    const settings = configuredSettings();
    settings.templates.entries.inbox = "{{unknown}}";
    settings.rules.rules[0]!.action.notePathTemplate = "../outside.md";
    expect(codes(settings)).toEqual(expect.arrayContaining(["TEMPLATE", "PATH"]));
  });

  it("migrates valid partial V1 settings and resets incompatible transport shapes", () => {
    const valid = configuredSettings();
    valid.uiLanguage = "zh-CN";
    const migrated = migrateSettings({
      schemaVersion: 1,
      uiLanguage: valid.uiLanguage,
      connections: valid.connections,
      processing: { concurrency: 7 },
    });
    expect(migrated.uiLanguage).toBe("zh-CN");
    expect(migrated.connections).toHaveLength(1);
    expect(migrated.processing.concurrency).toBe(7);
    expect(migrated.processing.maxPayloadBytes).toBe(256 * 1024);

    const reset = migrateSettings({ schemaVersion: 1, connections: [{ baseUrl: "old" }] });
    expect(reset.enabled).toBe(false);
    expect(reset.connections).toEqual([]);
  });
});
