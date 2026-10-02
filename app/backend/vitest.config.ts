import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "cloudflare:workers": new URL("./src/test/cloudflare-workers.ts", import.meta.url).pathname } },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test/**"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 85 },
    },
  },
});
