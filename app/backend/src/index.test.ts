import { describe, expect, it } from "vitest";
import worker from "./index";

// Health does not access D1; exercise the generated origin contract without a fake database.
const env: Pick<Env, "ALLOWED_ORIGIN"> = { ALLOWED_ORIGIN: "http://localhost:5173" };
function request(path = "/api/health", method = "GET", origin?: string) {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method, headers: origin === undefined ? {} : { Origin: origin },
  }), env as Env);
}

describe("Worker boundary", () => {
  it("serves a service health check without exposing database state", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "job-search-intelligence-api", timestamp: expect.any(String) });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("X-Request-Id")).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("allows only the exact configured browser origin", async () => {
    const response = await request("/api/health", "GET", env.ALLOWED_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(env.ALLOWED_ORIGIN);
    expect(response.headers.get("Vary")).toBe("Origin");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });
  it.each(["https://evil.example", "http://localhost:5173.evil.example", "null"])("rejects origin %s", async (origin) => {
    const response = await request("/api/health", "GET", origin);
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.json()).toMatchObject({ error: "origin_not_allowed" });
  });
  it("answers a preflight without cookies or mutations", async () => {
    const response = await request("/api/health", "OPTIONS", env.ALLOWED_ORIGIN);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
    expect(await response.text()).toBe("");
  });
  it("returns HEAD without a body", async () => {
    const response = await request("/api/health", "HEAD");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
  it("does not pretend private routes exist", async () => {
    const response = await request("/api/mailbox");
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it.each(["POST", "PUT", "DELETE"])("rejects %s", async (method) => {
    const response = await request("/api/health", method);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });
});
