import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureStableScreenshot } from "../../scripts/ui-screenshot.mjs";

describe("stable UI screenshot capture", () => {
  it("writes the synchronous CDP PNG after stable pre/post state checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "MQTT-ui-screenshot-"));
    const path = join(directory, "scene.png");
    const png = fixturePng(1280, 720);
    let samples = 0;
    try {
      const evidence = await captureStableScreenshot({
        path,
        label: "fixture-scene",
        cdp: async (method, params) => {
          expect(method).toBe("Page.captureScreenshot");
          expect(params.captureBeyondViewport).toBe(false);
          return JSON.stringify({ data: png.toString("base64") });
        },
        readState: async () => {
          samples += 1;
          return { ready: true, signature: { scene: "fixture-scene", hash: "stable" } };
        },
        timeoutMs: 500,
        sampleDelayMs: 0,
      });
      expect(await readFile(path)).toEqual(png);
      expect(evidence).toMatchObject({
        label: "fixture-scene",
        bytes: 24,
        width: 1280,
        height: 720,
      });
      expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(samples).toBeGreaterThanOrEqual(5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a capture when the semantic state changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "MQTT-ui-screenshot-"));
    const path = join(directory, "changed.png");
    const png = fixturePng(1280, 720);
    let samples = 0;
    try {
      await expect(
        captureStableScreenshot({
          path,
          label: "changing-scene",
          cdp: async () => JSON.stringify({ data: png.toString("base64") }),
          readState: async () => {
            samples += 1;
            return {
              ready: true,
              signature: { scene: "changing-scene", hash: samples >= 5 ? "changed" : "stable" },
            };
          },
          timeoutMs: 500,
          sampleDelayMs: 0,
        }),
      ).rejects.toThrow("UI state changed while capturing changing-scene");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function fixturePng(width, height) {
  const bytes = Buffer.alloc(24);
  bytes.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
