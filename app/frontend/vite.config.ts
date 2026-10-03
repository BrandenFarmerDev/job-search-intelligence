import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { pagesHeaders } from "./src/lib/pages-headers.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const apiOrigin = env.VITE_API_BASE_URL ? new URL(env.VITE_API_BASE_URL).origin : "'self'";
  return {
    plugins: [react(), {
      name: "response-headers",
      closeBundle() {
        writeFileSync(resolve("dist/_headers"), pagesHeaders(apiOrigin));
      },
    }],
    server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  };
});
