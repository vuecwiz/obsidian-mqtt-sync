import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const releaseFiles = ["main.js", "manifest.json", "styles.css"];
const fixedTimestamp = new Date("2000-01-01T00:00:00.000Z");

function fail(message) {
  throw new Error(`package-release: ${message}`);
}

function requestedTag(argv) {
  const index = argv.indexOf("--tag");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail("--tag requires a value");
  if (argv[index + 2]) fail(`unexpected argument: ${argv[index + 2]}`);
  return value;
}

async function readReleaseIdentity(tag) {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  const versions = JSON.parse(await readFile("versions.json", "utf8"));
  if (packageJson.version !== manifest.version) {
    fail(`package version ${packageJson.version} does not match manifest ${manifest.version}`);
  }
  if (versions[manifest.version] !== manifest.minAppVersion) {
    fail(`versions.json does not map ${manifest.version} to ${manifest.minAppVersion}`);
  }
  if (tag && tag !== manifest.version) {
    fail(`tag ${tag} must exactly match manifest version ${manifest.version}`);
  }
  return {
    pluginId: manifest.id,
    version: manifest.version,
    minAppVersion: manifest.minAppVersion,
  };
}

async function createArchive(identity) {
  const releaseDirectory = resolve(".artifacts/release");
  const stagingDirectory = resolve(releaseDirectory, ".package-staging");
  const archiveName = `${identity.pluginId}-${identity.version}.zip`;
  const archivePath = resolve(releaseDirectory, archiveName);
  const checksumPath = `${archivePath}.sha256`;
  await mkdir(releaseDirectory, { recursive: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });
  for (const file of releaseFiles) {
    const target = resolve(stagingDirectory, file);
    await copyFile(resolve(file), target);
    await chmod(target, 0o644);
    await utimes(target, fixedTimestamp, fixedTimestamp);
  }
  await rm(archivePath, { force: true });
  await rm(checksumPath, { force: true });
  const zipped = spawnSync("zip", ["-X", "-q", archivePath, ...releaseFiles], {
    cwd: stagingDirectory,
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
  });
  if (zipped.error?.code === "ENOENT") fail("zip executable is required");
  if (zipped.status !== 0) fail(zipped.stderr.trim() || `zip exited with ${zipped.status}`);
  const listed = spawnSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
  if (listed.error?.code === "ENOENT") fail("unzip executable is required");
  if (listed.status !== 0) fail(listed.stderr.trim() || `unzip exited with ${listed.status}`);
  const entries = listed.stdout.trim().split("\n").filter(Boolean);
  if (JSON.stringify(entries) !== JSON.stringify(releaseFiles)) {
    fail(`unexpected ZIP entries: ${JSON.stringify(entries)}`);
  }
  const archive = await readFile(archivePath);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  await writeFile(checksumPath, `${sha256}  ${archiveName}\n`, { mode: 0o644 });
  await rm(stagingDirectory, { recursive: true, force: true });
  return { archiveName, archivePath, checksumPath, bytes: archive.byteLength, sha256, entries };
}

export async function packageRelease(argv = process.argv.slice(2)) {
  const tag = requestedTag(argv);
  const identity = await readReleaseIdentity(tag);
  const archive = await createArchive(identity);
  const report = {
    schema: "obsidian.mqtt-sync.release-package.v1",
    identity,
    tag: tag ?? null,
    archive: {
      name: archive.archiveName,
      bytes: archive.bytes,
      sha256: archive.sha256,
      entries: archive.entries,
    },
    passed: true,
  };
  await writeFile(
    resolve(".artifacts/release/package-release.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  packageRelease()
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
