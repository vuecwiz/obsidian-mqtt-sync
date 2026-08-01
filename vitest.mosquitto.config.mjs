import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/mosquitto/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
