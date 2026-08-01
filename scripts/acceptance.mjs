import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const runId = process.env.MQTT_ACCEPTANCE_RUN_ID ?? new Date().toISOString().replace(/[:.]/gu, "-");
const directory = join(".artifacts", "acceptance", runId);
await mkdir(directory, { recursive: true });
const gates = [];

const deterministic = runNpm("verify");
gates.push({
  id: "deterministic",
  status: deterministic.status === 0 ? "passed" : "failed",
  evidence: ".artifacts/{unit,contract,integration,coverage,release}",
});

if (deterministic.status === 0) {
  const e2e = runNpm("test:e2e", { MQTT_ACCEPTANCE_RUN_ID: runId });
  const e2eReport = await readJsonIfPresent(join(".artifacts", "e2e", runId, "report.json"));
  gates.push({
    id: "broker-e2e",
    status: e2eReport?.status ?? (e2e.status === 0 ? "passed" : "failed"),
    counts: e2eReport?.counts,
    evidence: join(".artifacts", "e2e", runId, "report.json"),
  });
} else {
  gates.push({ id: "broker-e2e", status: "blocked", reason: "deterministic gate failed" });
}

if (process.env.OBSIDIAN_MQTT_TEST_VAULT) {
  const ui = runNpm("test:ui", { MQTT_UI_RUN_ID: runId });
  const uiReport = await readJsonIfPresent(join(".artifacts", "ui", runId, "report.json"));
  gates.push({
    id: "obsidian-ui",
    status: uiReport?.status ?? (ui.status === 0 ? "passed" : "failed"),
    checks: uiReport?.checks,
    cleanup: uiReport?.cleanup,
    evidence: join(".artifacts", "ui", runId, "report.json"),
  });
} else {
  gates.push({
    id: "obsidian-ui",
    status: "blocked",
    reason: "OBSIDIAN_MQTT_TEST_VAULT is not configured",
  });
}

const audit = spawnSync("npm", ["audit", "--audit-level=high"], {
  stdio: "ignore",
  env: process.env,
});
gates.push({ id: "dependency-audit", status: audit.status === 0 ? "passed" : "failed" });

const counts = Object.fromEntries(
  ["passed", "failed", "blocked", "skipped", "incomplete"].map((status) => [
    status,
    gates.filter((gate) => gate.status === status).length,
  ]),
);
const report = {
  schema: "obsidian.mqtt-sync.acceptance.v2",
  runId,
  generatedAt: new Date().toISOString(),
  gates,
  counts,
  status: counts.failed
    ? "failed"
    : counts.blocked || counts.skipped || counts.incomplete
      ? "incomplete"
      : "passed",
};
await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "passed") process.exitCode = 1;

function runNpm(script, extraEnvironment = {}) {
  return spawnSync("npm", ["run", script], {
    stdio: "inherit",
    env: { ...process.env, ...extraEnvironment },
  });
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}
