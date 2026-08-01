import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SAMPLE_DELAY_MS = 100;
const REQUIRED_STABLE_SAMPLES = 3;

export async function captureStableScreenshot({
  path,
  label,
  cdp,
  readState,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sampleDelayMs = DEFAULT_SAMPLE_DELAY_MS,
}) {
  const stable = await waitForStableState({
    label,
    readState,
    timeoutMs,
    sampleDelayMs,
  });
  const output = await cdp("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const response = JSON.parse(output);
  if (typeof response.data !== "string" || response.data.length === 0) {
    throw new Error(`CDP returned no PNG data for ${label}`);
  }
  const bytes = Buffer.from(response.data, "base64");
  if (bytes.length < 24 || bytes.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error(`CDP returned invalid PNG data for ${label}`);
  }
  const after = await readState();
  const afterKey = stateKey(after);
  if (!after?.ready || afterKey !== stable.key) {
    throw new Error(
      `UI state changed while capturing ${label}: ${JSON.stringify({ before: stable.state, after })}`,
    );
  }
  await writeFile(path, bytes);
  return {
    label,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    state: after.signature,
  };
}

async function waitForStableState({ label, readState, timeoutMs, sampleDelayMs }) {
  const deadline = Date.now() + timeoutMs;
  let previousKey;
  let stableSamples = 0;
  let latest;
  while (Date.now() < deadline) {
    latest = await readState();
    const key = stateKey(latest);
    if (latest?.ready && key === previousKey) {
      stableSamples += 1;
      if (stableSamples >= REQUIRED_STABLE_SAMPLES) return { key, state: latest };
    } else {
      stableSamples = 0;
    }
    previousKey = key;
    await delay(sampleDelayMs);
  }
  throw new Error(`Timed out waiting for screenshot state ${label}: ${JSON.stringify(latest)}`);
}

function stateKey(state) {
  return JSON.stringify(state?.signature);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
