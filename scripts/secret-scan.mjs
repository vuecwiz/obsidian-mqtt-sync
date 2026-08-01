import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (listed.status !== 0) {
  process.stderr.write("secret-scan: unable to enumerate repository files\n");
  process.exit(2);
}

const patterns = [
  { id: "private-key", expression: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { id: "telegram-bot-token", expression: /\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/g },
  { id: "github-token", expression: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { id: "gitlab-token", expression: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: "aws-access-key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    id: "credential-in-url",
    expression: /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/g,
  },
];

const findings = [];
let scannedFiles = 0;
for (const path of listed.stdout.split("\0").filter(Boolean)) {
  let content;
  try {
    content = await readFile(path);
  } catch {
    continue;
  }
  if (content.includes(0)) continue;
  scannedFiles += 1;
  const text = content.toString("utf8");
  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0;
    for (const match of text.matchAll(pattern.expression)) {
      findings.push({
        type: pattern.id,
        path,
        line: text.slice(0, match.index).split("\n").length,
      });
    }
  }
}

const report = {
  schema: "obsidian.mqtt-sync.secret-scan.v1",
  generatedAt: new Date().toISOString(),
  scannedFiles,
  findings,
  passed: findings.length === 0,
};
await mkdir(".artifacts/security", { recursive: true });
await writeFile(".artifacts/security/secret-scan.json", JSON.stringify(report, null, 2));
process.stdout.write(
  JSON.stringify({ scannedFiles, findings: findings.length, passed: report.passed }) + "\n",
);
if (!report.passed) {
  for (const finding of findings) {
    process.stderr.write(`${finding.type}: ${finding.path}:${finding.line}\n`);
  }
  process.exitCode = 1;
}
