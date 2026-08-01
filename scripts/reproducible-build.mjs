import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const releaseFiles = ["main.js", "manifest.json", "styles.css"];
const forbiddenReleaseMarkers = [
  "Preview Telegram Sync migration",
  "Expected five migration rules",
  "X / Twitter",
  "Obsidian/Twitter/x_clippings.md",
  "Obsidian/Github/github_clippings.md",
  "Clippings/MessagesFromMQTT.md",
  "Obsidian/Web/web_clippings.md",
  "mp.weixin.qq.com",
];

function build() {
  const result = spawnSync(process.execPath, ["esbuild.config.mjs", "production"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "reproducible-build: build failed\n");
    process.exit(result.status ?? 1);
  }
}

async function bundleIdentity() {
  const bundle = await readFile("main.js");
  return {
    bytes: bundle.byteLength,
    sha256: createHash("sha256").update(bundle).digest("hex"),
  };
}

async function archiveIdentity(timeZone) {
  const packaged = spawnSync(process.execPath, ["scripts/package-release.mjs"], {
    encoding: "utf8",
    env: { ...process.env, TZ: timeZone },
  });
  if (packaged.status !== 0) {
    process.stderr.write(packaged.stderr || "reproducible-build: packaging failed\n");
    process.exit(packaged.status ?? 1);
  }
  const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  const archive = await readFile(`.artifacts/release/${manifest.id}-${manifest.version}.zip`);
  return {
    bytes: archive.byteLength,
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
}

async function assertReleasePrivacy() {
  const findings = [];
  for (const file of releaseFiles) {
    const content = await readFile(file, "utf8");
    for (const marker of forbiddenReleaseMarkers) {
      if (content.includes(marker)) findings.push({ file, marker });
    }
  }
  if (findings.length) {
    process.stderr.write(
      `reproducible-build: release privacy check failed: ${JSON.stringify(findings)}\n`,
    );
    process.exit(1);
  }
  return { scannedFiles: releaseFiles.length, findings: 0 };
}

async function assertRuntimeImports() {
  const bundle = await readFile("main.js", "utf8");
  const imports = [...bundle.matchAll(/\brequire\(["']([^"']+)["']\)/gu)].map((match) => match[1]);
  const unexpected = [...new Set(imports)].filter(
    (name) =>
      !["obsidian", "electron"].includes(name) &&
      !name.startsWith("node:") &&
      !builtinRuntimeImports.has(name),
  );
  if (unexpected.length) {
    process.stderr.write(
      `reproducible-build: unresolved runtime imports: ${JSON.stringify(unexpected)}\n`,
    );
    process.exit(1);
  }
  return { imports: [...new Set(imports)].sort(), unexpected: 0 };
}

const builtinRuntimeImports = new Set([
  "assert",
  "buffer",
  "crypto",
  "dns",
  "events",
  "fs",
  "http",
  "https",
  "net",
  "os",
  "path",
  "querystring",
  "stream",
  "string_decoder",
  "tls",
  "tty",
  "url",
  "util",
  "worker_threads",
  "zlib",
  // Optional native ws accelerators are loaded inside guarded try/catch blocks.
  "bufferutil",
  "utf-8-validate",
]);

build();
const first = await bundleIdentity();
build();
const second = await bundleIdentity();
const archiveFromUtcMinusEight = await archiveIdentity("America/Los_Angeles");
const archiveFromUtcPlusFourteen = await archiveIdentity("Pacific/Kiritimati");
const releasePrivacy = await assertReleasePrivacy();
const runtimeImports = await assertRuntimeImports();
const report = {
  schema: "obsidian.mqtt-sync.reproducible-build.v1",
  generatedAt: new Date().toISOString(),
  first,
  second,
  archiveFromUtcMinusEight,
  archiveFromUtcPlusFourteen,
  releasePrivacy,
  runtimeImports,
  passed:
    first.bytes === second.bytes &&
    first.sha256 === second.sha256 &&
    archiveFromUtcMinusEight.bytes === archiveFromUtcPlusFourteen.bytes &&
    archiveFromUtcMinusEight.sha256 === archiveFromUtcPlusFourteen.sha256 &&
    releasePrivacy.findings === 0 &&
    runtimeImports.unexpected === 0,
};
await mkdir(".artifacts/release", { recursive: true });
await writeFile(".artifacts/release/reproducible-build.json", JSON.stringify(report, null, 2));
process.stdout.write(
  JSON.stringify({
    bytes: second.bytes,
    sha256: second.sha256,
    archive: archiveFromUtcPlusFourteen,
    releasePrivacy,
    passed: report.passed,
  }) + "\n",
);
if (!report.passed) process.exitCode = 1;
