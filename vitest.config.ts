import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { obsidian: resolve(import.meta.dirname, "tests/helpers/obsidian-runtime.ts") },
  },
  test: {
    environment: "node",
    exclude: ["tests/mosquitto/**"],
    globals: true,
    setupFiles: ["tests/setup.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: ".artifacts/coverage",
      include: ["src/transport/mqtt/{normalizer,topic}.ts"],
      thresholds: {
        branches: 80,
        lines: 90,
      },
    },
  },
});
