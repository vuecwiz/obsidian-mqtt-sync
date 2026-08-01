import { normalizedTlsConfig, validateTlsConfig } from "../../src/settings/tls";

describe("TLS certificate settings", () => {
  it("accepts an empty or complete TLS configuration", () => {
    expect(validateTlsConfig({})).toBeUndefined();
    expect(
      validateTlsConfig({
        caPem: "CA",
        clientCertificatePem: "CERTIFICATE",
        privateKeyPem: "PRIVATE KEY",
      }),
    ).toBeUndefined();
  });

  it("requires the client certificate and private key as a pair", () => {
    expect(validateTlsConfig({ clientCertificatePem: "CERTIFICATE" })).toBe("CLIENT_PAIR");
    expect(validateTlsConfig({ privateKeyPem: "PRIVATE KEY" })).toBe("CLIENT_PAIR");
    expect(validateTlsConfig({ caPem: 42 })).toBe("TYPE");
  });

  it("trims PEM values and removes empty fields before persistence", () => {
    expect(
      normalizedTlsConfig({
        caPem: "  CA\n",
        clientCertificatePem: " ",
        privateKeyPem: "",
      }),
    ).toEqual({ caPem: "CA", clientCertificatePem: undefined, privateKeyPem: undefined });
  });
});
