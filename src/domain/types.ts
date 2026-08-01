export type SourceKey = string;
export type MqttQos = 0 | 1 | 2;
export type UiLanguageSetting = "auto" | "en" | "zh-CN";

export interface MqttAuthConfig {
  username?: string;
  password?: string;
}

export interface MqttTlsConfig {
  caPem?: string;
  clientCertificatePem?: string;
  privateKeyPem?: string;
}

export interface SubscriptionConfigV1 {
  filter: string;
  qos: MqttQos;
  noLocal: boolean;
  retainAsPublished: boolean;
  retainHandling: 0 | 1 | 2;
  enabled: boolean;
}

export interface ConnectionConfigV1 {
  id: string;
  name: string;
  brokerUrl: string;
  protocolVersion: 4 | 5;
  clientId: string;
  auth: MqttAuthConfig;
  tls: MqttTlsConfig;
  allowInsecureRemote: boolean;
  keepAliveSeconds: number;
  connectTimeoutMs: number;
  cleanStart: boolean;
  sessionExpirySeconds: number;
  subscriptions: SubscriptionConfigV1[];
  reconnect: { minMs: number; maxMs: number; jitterRatio: number };
  useCorrelationDataAsId: boolean;
  result?: {
    topic: string;
    qos: MqttQos;
    retain: boolean;
    privacy: "minimal" | "paths";
  };
}

export interface ProcessingConfigV1 {
  dedupeWindowSeconds: number;
  maxPayloadBytes: number;
  maxAttachmentBytes: number;
  attachmentTimeoutMs: number;
  allowedAttachmentOrigins: string[];
  maxAttempts: number;
  concurrency: number;
  completedRetentionDays: number;
  completedRetentionCount: number;
  downloadEnvelopeAttachments: boolean;
}

export interface PersistedSettingsV1 {
  schemaVersion: 1;
  uiLanguage: UiLanguageSetting;
  enabled: boolean;
  device: { deviceId: string; writerDeviceId: string };
  connections: ConnectionConfigV1[];
  rules: RuleSetV1;
  templates: TemplateCatalogV1;
  processing: ProcessingConfigV1;
  diagnostics: { logLevel: "error" | "info" | "debug"; redactBodies: boolean };
}

export interface AttachmentDescriptor {
  name: string;
  url: string;
  type?: string;
  size?: number;
  sha256?: string;
}

export interface IncomingMessage {
  schemaVersion: 1;
  key: SourceKey;
  identityKind: "envelope-id" | "correlation-data" | "retained" | "fingerprint";
  source: {
    connectionId: string;
    brokerHash: string;
    topic: string;
    messageId: string;
    protocolVersion: 4 | 5;
    matchingFilters: string[];
  };
  publishedAtMs: number;
  receivedAtMs: number;
  body: string;
  title: string;
  priority: 1 | 2 | 3 | 4 | 5;
  tags: string[];
  delivery: { qos: MqttQos; retain: boolean; duplicate: boolean; packetId?: number };
  payload: { byteLength: number; sha256: string; text?: string; json?: unknown };
  contentType?: string;
  payloadFormatIndicator?: 0 | 1;
  userProperties: Record<string, string[]>;
  responseTopic?: string;
  correlationData?: string;
  firstUrl?: { raw: string; protocol: "http:" | "https:"; hostname: string };
  attachment?: AttachmentDescriptor;
  unknownFields: string[];
}

export interface RuleSetV1 {
  schemaVersion: 1;
  matchMode: "first";
  rules: RuleV1[];
}
export interface RuleV1 {
  id: string;
  revision: number;
  name: string;
  enabled: boolean;
  when: { all: ConditionV1[] };
  action: {
    notePathTemplate: string;
    contentTemplateId: string;
    attachmentPathTemplate?: string;
    insertion: "append" | "prepend" | "after-heading";
    heading?: string;
  };
}
export type ConditionV1 =
  | {
      field: "topic" | "title" | "body" | "contentType" | "responseTopic";
      op: "equals" | "contains" | "startsWith";
      value: string;
    }
  | { field: "topic"; op: "matchesFilter"; value: string }
  | { field: "tag"; op: "contains"; value: string }
  | { field: "priority" | "qos"; op: "equals" | "gte"; value: number }
  | {
      field: "hasAttachment" | "hasHttpUrl" | "retain" | "duplicate" | "hasCorrelationData";
      op: "equals";
      value: boolean;
    }
  | { field: "attachmentMime"; op: "equals" | "startsWith"; value: string }
  | { field: "firstUrlHost"; op: "hostEquals" | "hostOrSubdomainOf"; value: string };

export interface TemplateCatalogV1 {
  schemaVersion: 1;
  entries: Record<string, string>;
}
export interface EffectPlanV1 {
  schemaVersion: 1;
  sourceKey: SourceKey;
  ruleId: string;
  ruleRevision: number;
  notePath: string;
  marker: string;
  renderedBlock: string;
  insertion: { mode: "append" | "prepend" | "after-heading"; heading?: string };
  attachment?: {
    mode: "download" | "link-only" | "reject";
    sourceUrl: string;
    targetPath?: string;
    expectedMaxBytes: number;
    expectedSha256?: string;
  };
}
export interface EffectReceiptV1 {
  notePath: string;
  markerFound: boolean;
  alreadyApplied: boolean;
  attachmentPath?: string;
  attachmentBytes?: number;
  attachmentSha256?: string;
  committedAtMs: number;
}
export type InboxStatus =
  | "accepted"
  | "planned"
  | "applying"
  | "committed"
  | "complete"
  | "retry_wait"
  | "dead_letter"
  | "ignored";
export interface SafeErrorV1 {
  code: string;
  message: string;
  retryable: boolean;
  atMs: number;
}
export interface InboxRecordV1 {
  schemaVersion: 1;
  message: IncomingMessage;
  status: InboxStatus;
  attempts: number;
  nextAttemptAtMs?: number;
  plan?: EffectPlanV1;
  receipt?: EffectReceiptV1;
  resultStatus?: "none" | "pending" | "sent" | "failed";
  lastError?: SafeErrorV1;
  errorHistory: SafeErrorV1[];
  createdAtMs: number;
  updatedAtMs: number;
  lastSeenAtMs: number;
}
export interface OutboxRecordV1 {
  sourceKey: SourceKey;
  connectionId: string;
  payload: ResultPayloadV1;
  attempts: number;
  nextAttemptAtMs: number;
  status: "pending" | "sent" | "failed";
  lastError?: SafeErrorV1;
}
export interface ResultPayloadV1 {
  schema: "obsidian.mqtt-sync.result.v1";
  correlation: { topic: string; messageId: string };
  outcome: "succeeded" | "failed" | "ignored";
  processedAt: string;
  targetCount: number;
  targets?: string[];
  error?: { code: string; retryable: boolean; attempt: number };
}
export interface TopicStateV1 {
  replayWatermarkMs: number;
}
export interface DurableStatePayloadV1 {
  schemaVersion: 1;
  records: Record<SourceKey, InboxRecordV1>;
  outbox: Record<SourceKey, OutboxRecordV1>;
  topics: Record<string, TopicStateV1>;
  telemetry: { ignoredEvents: Record<string, number>; protocolErrors: number; duplicates: number };
  updatedAtMs: number;
}
export interface DurableStateFileV1 {
  schemaVersion: 1;
  checksum: string;
  payload: DurableStatePayloadV1;
}
export interface TransportFault {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
}
export type ConnectionStatus =
  | "disabled"
  | "monitor_only"
  | "connecting"
  | "connected"
  | "subscribing"
  | "backoff"
  | "auth_failed"
  | "stopped"
  | "error";
export interface ConnectionTelemetry {
  connectionId: string;
  status: ConnectionStatus;
  lastConnectedAtMs?: number;
  lastEventAtMs?: number;
  lastFault?: TransportFault;
  reconnectAttempts: number;
  sessionPresent?: boolean;
  subscriptionCount?: number;
}
