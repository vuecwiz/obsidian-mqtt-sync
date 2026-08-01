import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const runId = process.env.MQTT_ACCEPTANCE_RUN_ID ?? new Date().toISOString().replace(/[:.]/gu, "-");
const artifactDirectory = join(".artifacts", "e2e", runId);
await mkdir(artifactDirectory, { recursive: true });
const scenarios = [];
const mosquittoExecutable = process.env.MOSQUITTO_BIN ?? "mosquitto";
let broker;
let cleanup;

const integrationReport = join(artifactDirectory, "aedes-vitest.json");
const integration = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "tests/integration/local-broker.test.ts",
    "--reporter=json",
    `--outputFile=${integrationReport}`,
  ],
  { encoding: "utf8", env: process.env },
);
if (integration.status === 0) {
  const report = JSON.parse(await readFile(integrationReport, "utf8"));
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      scenarios.push({
        id: `aedes:${slug(assertion.fullName ?? assertion.title)}`,
        layer: "process-internal-mqtt-3.1.1",
        status: assertion.status === "passed" ? "passed" : "failed",
      });
    }
  }
} else {
  scenarios.push({
    id: "aedes:integration-process",
    layer: "process-internal-mqtt-3.1.1",
    status: "failed",
    reason: "integration process failed; inspect ignored Vitest artifact",
  });
}

const mosquittoVersion = spawnSync(mosquittoExecutable, ["-h"], { encoding: "utf8" });
if (mosquittoVersion.error?.code === "ENOENT") {
  scenarios.push({
    id: "mosquitto:broker-interoperability",
    layer: "real-local-broker",
    status: "blocked",
    reason: "Mosquitto is not installed",
  });
} else {
  const mosquitto = spawnSync(process.execPath, ["scripts/mosquitto-e2e.mjs"], {
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
  });
  const line = mosquitto.stdout
    .trim()
    .split("\n")
    .findLast((value) => value.startsWith("{"));
  if (!line) {
    scenarios.push({
      id: "mosquitto:harness-process",
      layer: "real-local-broker",
      status: "failed",
      reason: "harness produced no machine-readable report",
    });
  } else {
    const report = JSON.parse(line);
    broker = { implementation: report.broker, version: report.brokerVersion };
    cleanup = report.cleanup;
    for (const result of report.results ?? []) {
      scenarios.push({ ...result, id: `mosquitto:${result.id}`, layer: "real-local-broker" });
    }
    if (mosquitto.status !== 0 && !report.results?.some((result) => result.status === "failed")) {
      scenarios.push({
        id: "mosquitto:harness-process",
        layer: "real-local-broker",
        status: "failed",
        reason: "harness exited unsuccessfully",
      });
    }
  }
}

const counts = Object.fromEntries(
  ["passed", "failed", "blocked", "skipped"].map((status) => [
    status,
    scenarios.filter((scenario) => scenario.status === status).length,
  ]),
);
const requirements = buildRequirementEvidence(scenarios);
const requirementStatuses = Object.values(requirements).map((requirement) => requirement.status);
const report = {
  schema: "obsidian.mqtt-sync.e2e.v2",
  runId,
  generatedAt: new Date().toISOString(),
  publicNetworkUsed: false,
  brokerServiceChanged: false,
  broker,
  cleanup,
  scenarios,
  requirements,
  counts,
  status:
    counts.failed ||
    requirementStatuses.some((status) => status === "failed" || status === "missing")
      ? "failed"
      : counts.blocked ||
          counts.skipped ||
          requirementStatuses.some((status) => status === "blocked" || status === "incomplete")
        ? "incomplete"
        : "passed",
};
await writeFile(join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "passed") process.exitCode = 1;

function slug(value = "scenario") {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function buildRequirementEvidence(allScenarios) {
  const expected = {
    mqtt311: ["mosquitto:mqtt-3.1.1-connect"],
    mqtt5: ["mosquitto:mqtt-5-connect"],
    qos0: ["mosquitto:mqtt-3.1.1-qos-0"],
    qos1: ["mosquitto:mqtt-3.1.1-qos-1"],
    qos2: ["mosquitto:mqtt-3.1.1-qos-2", "mosquitto:result-publish-qos-2"],
    retain: ["mosquitto:mqtt-retain-live-and-replay"],
    retainHandling: ["mosquitto:mqtt-5-retain-handling-rh-2"],
    retainAsPublished: ["mosquitto:mqtt-5-retain-as-published-rap"],
    noLocal: ["mosquitto:mqtt-5-no-local-nl"],
    cleanStart: ["mosquitto:mqtt-5-clean-start-session-present-false"],
    sessionExpiry: [
      "mosquitto:mqtt-5-session-expiry-session-present-true",
      "mosquitto:persistent-session-offline-qos-1-replay",
    ],
    reconnectResubscribe: ["mosquitto:reconnect-and-explicit-resubscribe"],
    duplicateClientId: ["mosquitto:duplicate-client-id-eviction"],
    resultPublish: ["mosquitto:result-publish-qos-2"],
    authentication: ["mosquitto:authentication-rejection"],
    acl: ["mosquitto:acl-authorized-subscription", "mosquitto:acl-publish-rejection"],
    mqtt: ["mosquitto:mqtt-5-connect"],
    mqtts: ["mosquitto:mqtts-server-authenticated"],
    ws: ["mosquitto:websocket-mqtt-5"],
    wss: ["mosquitto:wss-server-authenticated"],
    hostnameMismatch: ["mosquitto:tls-hostname-mismatch-rejected"],
    untrustedCertificate: ["mosquitto:tls-untrusted-ca-rejected"],
    expiredCertificate: ["mosquitto:tls-expired-server-certificate-rejected"],
    mutualTls: [
      "mosquitto:mtls-client-certificate-and-qos-2",
      "mosquitto:mtls-wss-client-certificate",
      "mosquitto:tls-client-certificate-required",
    ],
    tlsBypassProhibited: ["mosquitto:tls-verification-bypass-prohibited"],
    gracefulDisconnect: ["mosquitto:mqtt-graceful-disconnect"],
  };
  const unavailable = allScenarios.find(
    (scenario) => scenario.id === "mosquitto:broker-interoperability",
  );
  return Object.fromEntries(
    Object.entries(expected).map(([requirement, scenarioIds]) => {
      if (unavailable)
        return [
          requirement,
          { status: unavailable.status, scenarioIds, reason: unavailable.reason },
        ];
      const evidence = scenarioIds.map((id) => allScenarios.find((scenario) => scenario.id === id));
      const status = evidence.some((scenario) => !scenario)
        ? "missing"
        : evidence.some((scenario) => scenario.status === "failed")
          ? "failed"
          : evidence.every((scenario) => scenario.status === "passed")
            ? "passed"
            : "incomplete";
      return [requirement, { status, scenarioIds }];
    }),
  );
}
