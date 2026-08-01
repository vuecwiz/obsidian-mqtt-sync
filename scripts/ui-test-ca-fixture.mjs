import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const DOCUMENTS = [
  "tests/fixtures/ui-ca/mosquitto-org-ca.pem",
  "tests/fixtures/ui-ca/digicert-global-root-ca.pem",
];

export async function loadDocumentedUiTestCaBundle(now = new Date()) {
  const certificates = [];
  for (const documentPath of DOCUMENTS) {
    const pem = (await readFile(resolve(documentPath), "utf8")).trim();
    if (
      !pem.startsWith("-----BEGIN CERTIFICATE-----") ||
      !pem.endsWith("-----END CERTIFICATE-----")
    ) {
      throw new Error(`Invalid PEM certificate fixture: ${documentPath}`);
    }
    const certificate = new X509Certificate(pem);
    if (now < new Date(certificate.validFrom) || now > new Date(certificate.validTo)) {
      throw new Error(`UI CA fixture is outside its validity window: ${documentPath}`);
    }
    certificates.push(pem);
  }
  const pem = certificates.join("\n");
  return {
    pem,
    certificateCount: certificates.length,
    bytes: Buffer.byteLength(pem),
    lines: pem.split("\n").length,
    sha256: createHash("sha256").update(pem).digest("hex").slice(0, 12),
  };
}
