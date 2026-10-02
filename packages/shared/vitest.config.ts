import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 85 },
    },
  },
});
