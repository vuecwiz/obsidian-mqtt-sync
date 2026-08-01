import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const runId = `self-test-${randomBytes(8).toString("hex")}`;
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("MQTT_PUBLIC_")),
);
environment.MQTT_PUBLIC_TEST_RUN_ID = runId;

const child = spawnSync(process.execPath, ["scripts/mosquitto-public-e2e.mjs"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: environment,
  timeout: 30_000,
});
assert(child.status === 0, "disabled runner exit code");
assert(!child.stderr.trim(), "disabled runner stderr");

const reportPath = join(".artifacts", "public-mosquitto", runId, "report.json");
const report = JSON.parse(await readFile(reportPath, "utf8"));
assert(report.schema === "obsidian.mqtt-sync.public-mosquitto.v1", "report schema");
assert(report.status === "skipped", "disabled status");
assert(report.publicNetworkUsed === false, "disabled public-network marker");
assert(report.counts?.skipped === 1, "disabled skipped count");
assert(report.results?.[0]?.reasonCode === "explicit-enable-not-set", "disabled reason code");
assert(report.cleanup?.clientsClosed === true, "disabled client cleanup");
assert(report.cleanup?.temporaryDirectoryRemoved === true, "disabled temporary cleanup");
assert(report.cleanup?.errors?.length === 0, "disabled cleanup errors");

const unsafeRunId = "../synthetic-unsafe-run-id";
const safeRunId = `invalid-run-id-${createHash("sha256").update(unsafeRunId).digest("hex").slice(0, 12)}`;
const unsafeEnvironment = { ...environment, MQTT_PUBLIC_TEST_RUN_ID: unsafeRunId };
const unsafeChild = spawnSync(process.execPath, ["scripts/mosquitto-public-e2e.mjs"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: unsafeEnvironment,
  timeout: 30_000,
});
assert(unsafeChild.status === 0, "unsafe run ID disabled exit code");
const safeReport = JSON.parse(
  await readFile(join(".artifacts", "public-mosquitto", safeRunId, "report.json"), "utf8"),
);
assert(safeReport.runId === safeRunId, "unsafe run ID hashed artifact path");
assert(safeReport.publicNetworkUsed === false, "unsafe run ID public-network marker");

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
for (const scriptName of [
  "verify",
  "test:unit",
  "test:integration",
  "test:e2e",
  "test:acceptance",
]) {
  assert(
    !packageJson.scripts?.[scriptName]?.includes("test:e2e:public:mosquitto"),
    `${scriptName} public-runner isolation`,
  );
}

process.stdout.write(
  `${JSON.stringify({ passed: true, runId, status: report.status, publicNetworkUsed: false, cleanup: report.cleanup })}\n`,
);

function assert(condition, label) {
  if (!condition) throw new Error(`Public Mosquitto runner self-test failed: ${label}`);
}
