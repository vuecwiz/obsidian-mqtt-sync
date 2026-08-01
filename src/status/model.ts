import type { ConnectionTelemetry } from "../domain/types";
import { createI18n, type I18n, type TranslationKey } from "../i18n";

const EN_I18N = createI18n("en", "en");

export type MQTTStatusState =
  | "off"
  | "monitor_only"
  | "idle"
  | "connecting"
  | "connected"
  | "backoff"
  | "error";

export interface MQTTStatusContext {
  enabled: boolean;
  writer: boolean;
  runtimeError?: string;
  connections: readonly ConnectionTelemetry[];
  topicCount: number;
  inbox?: {
    total: number;
    pending: number;
    deadLetters: number;
    outboxPending: number;
  };
  nowMs?: number;
}

export interface MQTTStatusView {
  state: MQTTStatusState;
  icon: string;
  label: string;
  tooltip: string;
}

const STATUS_META: Record<MQTTStatusState, { icon: string; labelKey: TranslationKey }> = {
  off: { icon: "MQTT-status-off", labelKey: "status.off" },
  monitor_only: { icon: "MQTT-status-monitor", labelKey: "status.monitorOnly" },
  idle: { icon: "MQTT-status-idle", labelKey: "status.idle" },
  connecting: { icon: "MQTT-status-connecting", labelKey: "status.connecting" },
  connected: { icon: "MQTT-status-connected", labelKey: "status.connected" },
  backoff: { icon: "MQTT-status-backoff", labelKey: "status.retrying" },
  error: { icon: "MQTT-status-error", labelKey: "status.error" },
};

export function deriveMQTTStatusState(context: MQTTStatusContext): MQTTStatusState {
  if (!context.enabled) return "off";
  if (!context.writer) return "monitor_only";
  const statuses = context.connections.map((connection) => connection.status);
  if (statuses.some((status) => status === "auth_failed" || status === "error")) return "error";
  if (statuses.includes("backoff")) return "backoff";
  if (statuses.includes("connecting")) return "connecting";
  if (statuses.includes("subscribing")) return "connecting";
  if (statuses.includes("connected")) return "connected";
  if (context.runtimeError) return "error";
  return "idle";
}

export function buildMQTTStatusView(
  context: MQTTStatusContext,
  i18n: I18n = EN_I18N,
): MQTTStatusView {
  const state = deriveMQTTStatusState(context);
  const meta = STATUS_META[state];
  const label = i18n.t(meta.labelKey);
  const counts = countStatuses(context.connections);
  const lines = [
    `MQTT Sync — ${label}`,
    `${i18n.t("status.receiving")}: ${i18n.t(context.enabled ? "status.enabled" : "status.disabled")}`,
    `${i18n.t("status.writer")}: ${i18n.t(context.writer ? "status.thisDevice" : "status.anotherDevice")}`,
    `${i18n.t("status.connections")}: ${context.connections.length || i18n.t("status.none")}${formatConnectionCounts(counts, i18n)}`,
    `${i18n.t("status.subscriptions")}: ${context.topicCount}`,
  ];
  const lastConnectedAtMs = maxTimestamp(
    context.connections.map((connection) => connection.lastConnectedAtMs),
  );
  const lastEventAtMs = maxTimestamp(
    context.connections.map((connection) => connection.lastEventAtMs),
  );
  lines.push(
    `${i18n.t("status.lastConnected")}: ${formatAge(lastConnectedAtMs, i18n, context.nowMs)}`,
  );
  lines.push(`${i18n.t("status.lastMessage")}: ${formatAge(lastEventAtMs, i18n, context.nowMs)}`);
  const reconnectAttempts = context.connections.reduce(
    (sum, connection) => sum + connection.reconnectAttempts,
    0,
  );
  lines.push(`${i18n.t("status.reconnectAttempts")}: ${reconnectAttempts}`);
  const faultCode = context.connections.find((connection) => connection.lastFault)?.lastFault?.code;
  if (faultCode) lines.push(`${i18n.t("status.lastFault")}: ${faultCode}`);
  else if (context.runtimeError)
    lines.push(`${i18n.t("status.error")}: ${safeRuntimeError(context.runtimeError, i18n)}`);
  if (context.inbox) {
    lines.push(
      `${i18n.t("status.inbox")}: ${context.inbox.total} ${i18n.t("status.total")} · ${context.inbox.pending} ${i18n.t("status.pending")} · ${context.inbox.deadLetters} ${i18n.t("status.deadLetter")}`,
    );
    lines.push(
      `${i18n.t("status.resultOutbox")}: ${context.inbox.outboxPending} ${i18n.t("status.pending")}`,
    );
  }
  return { state, icon: meta.icon, label, tooltip: lines.join("\n") };
}

function countStatuses(connections: readonly ConnectionTelemetry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const connection of connections) {
    counts[connection.status] = (counts[connection.status] ?? 0) + 1;
  }
  return counts;
}

function formatConnectionCounts(counts: Record<string, number>, i18n: I18n): string {
  const entries = ["connected", "subscribing", "connecting", "backoff", "auth_failed", "error"]
    .filter((status) => counts[status])
    .map(
      (status) =>
        `${counts[status]} ${status === "subscribing" ? "subscribing" : i18n.t(`status.connection.${status}` as TranslationKey)}`,
    );
  return entries.length ? ` · ${entries.join(", ")}` : "";
}

function maxTimestamp(values: readonly (number | undefined)[]): number | undefined {
  const timestamps = values.filter((value): value is number => typeof value === "number");
  return timestamps.length ? Math.max(...timestamps) : undefined;
}

function formatAge(timestamp: number | undefined, i18n: I18n, nowMs = Date.now()): string {
  if (timestamp === undefined) return i18n.t("status.never");
  const seconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (seconds < 5) return i18n.t("status.justNow");
  if (seconds < 60) return i18n.t("status.secondsAgo", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return i18n.t("status.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n.t("status.hoursAgo", { count: hours });
  return i18n.t("status.daysAgo", { count: Math.floor(hours / 24) });
}

function safeRuntimeError(error: string, i18n: I18n): string {
  const code = error.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0];
  if (code) return code;
  const path = error.match(/^[a-zA-Z][a-zA-Z0-9_.[\]-]*/)?.[0];
  return path ? i18n.t("status.pathDiagnostics", { path }) : i18n.t("status.seeDiagnostics");
}
