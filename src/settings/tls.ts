import type { MqttTlsConfig } from "../domain/types";

export type TlsValidationCode = "TYPE" | "CLIENT_PAIR";

export function validateTlsConfig(value: unknown): TlsValidationCode | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "TYPE";
  const tls = value as Record<string, unknown>;
  for (const field of ["caPem", "clientCertificatePem", "privateKeyPem"] as const) {
    if (tls[field] !== undefined && typeof tls[field] !== "string") return "TYPE";
  }
  const hasCertificate = Boolean((tls.clientCertificatePem as string | undefined)?.trim());
  const hasPrivateKey = Boolean((tls.privateKeyPem as string | undefined)?.trim());
  return hasCertificate === hasPrivateKey ? undefined : "CLIENT_PAIR";
}

export function normalizedTlsConfig(value: MqttTlsConfig): MqttTlsConfig {
  const normalize = (text: string | undefined): string | undefined => text?.trim() || undefined;
  return {
    caPem: normalize(value.caPem),
    clientCertificatePem: normalize(value.clientCertificatePem),
    privateKeyPem: normalize(value.privateKeyPem),
  };
}
