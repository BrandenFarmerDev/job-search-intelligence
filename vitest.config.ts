import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["scripts/deployment-config.ts"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 85 },
    },
  },
});
