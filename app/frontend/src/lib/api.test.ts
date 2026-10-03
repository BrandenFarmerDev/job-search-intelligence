import { describe, expect, it, vi } from "vitest";
import { exportUrl, getApiHealth, intelligenceApi } from "./api";

describe("API client", () => {
  const health = { status: "ok", service: "job-search-intelligence-api", timestamp: "2026-10-01T00:00:00Z" };
  it("validates the protected health response using the owner session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(health)));
    expect(await getApiHealth()).toEqual(health);
    expect(fetch).toHaveBeenCalledWith("/api/health", expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }));
  });
  it("uses a configured public API origin and a cancellation signal", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(health)));
    const controller = new AbortController();
    await getApiHealth(controller.signal);
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    controller.abort();
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledWith("https://api.example.com/api/health", expect.any(Object));
  });
  it("rejects an HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(getApiHealth()).rejects.toThrow("unavailable");
  });
  it("rejects a different service response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...health, service: "portfolio-api" })));
    await expect(getApiHealth()).rejects.toThrow("invalid health");
  });
  it("handles network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network unavailable")));
    await expect(getApiHealth()).rejects.toThrow("Network unavailable");
  });
});

it("uses owner credentials, JSON mutations, cancellation and bounded timeouts",async()=>{
  const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(Response.json({saved:true})));vi.stubGlobal("fetch",fetcher);
  expect(await intelligenceApi("/sync/run","POST",{x:1},new AbortController().signal)).toEqual({saved:true});
  expect(fetcher).toHaveBeenCalledWith("/api/job-intelligence/sync/run",expect.objectContaining({credentials:"include",headers:{"Content-Type":"application/json"},body:'{"x":1}'}));
  await intelligenceApi("/dashboard");expect(exportUrl()).toBe("/api/job-intelligence/export");
  vi.stubEnv("VITE_API_BASE_URL","https://api.example.com");expect(exportUrl()).toBe("https://api.example.com/api/job-intelligence/export");
});
it("reports owner sign-in and safe error codes for provider failures",async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:401}));vi.stubGlobal("fetch",fetcher);await expect(intelligenceApi("/dashboard")).rejects.toThrow("Sign in");
  fetcher.mockResolvedValue(Response.json({error:"setup_required"},{status:503}));await expect(intelligenceApi("/dashboard")).rejects.toThrow("setup required");
  for(const response of [new Response("bad",{status:500}),Response.json({error:42},{status:500})]){fetcher.mockResolvedValue(response);await expect(intelligenceApi("/dashboard")).rejects.toThrow("Request failed");}
});
