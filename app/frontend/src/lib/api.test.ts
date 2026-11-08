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
    await expect(getApiHealth()).rejects.toThrow("Check your connection");
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

it.each([new Response("<html>edge</html>", {status:429}), Response.json({error:"rate_limited"},{status:429}), Response.json({error:"rate_limit_unavailable"},{status:503})])("explains readable admission failures without replay", async(response)=>{
 const fetcher=vi.fn().mockResolvedValue(response);vi.stubGlobal("fetch",fetcher);
 await expect(intelligenceApi("/sync/run","POST",{})).rejects.toThrow(/wait.*60 seconds/i);
 expect(fetcher).toHaveBeenCalledTimes(1);
});
it("reports opaque mutation uncertainty and preserves cancellation",async()=>{
 const fetcher=vi.fn().mockRejectedValue(new TypeError("private transport"));vi.stubGlobal("fetch",fetcher);
 await expect(intelligenceApi("/applications","PATCH",{})).rejects.toThrow("Check the app state");expect(fetcher).toHaveBeenCalledTimes(1);
 const controller=new AbortController();controller.abort();const abort=new DOMException("Cancelled","AbortError");fetcher.mockRejectedValue(abort);
 await expect(intelligenceApi("/applications","POST",{},controller.signal)).rejects.toBe(controller.signal.reason);expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([200,503,500])("preserves cancellation during status %s body reads",async(status)=>{
 const controller=new AbortController();const reason=new DOMException("Cancelled body","AbortError");
 let rejectBody!:(error:unknown)=>void;
 const response=Response.json({error:"rate_limit_unavailable"},{status});
 const json=()=>new Promise((_,reject)=>{rejectBody=reject;});vi.spyOn(response,"json").mockImplementation(json);vi.spyOn(response,"clone").mockReturnValue(response);
 const fetcher=vi.fn().mockResolvedValue(response);vi.stubGlobal("fetch",fetcher);
 const pending=intelligenceApi("/dashboard","GET",undefined,controller.signal);
 await vi.waitFor(()=>expect(rejectBody).toBeTypeOf("function"));controller.abort(reason);rejectBody(reason);
 await expect(pending).rejects.toBe(reason);expect(fetcher).toHaveBeenCalledTimes(1);
});
it("preserves a cancellation delivered with readable 429 headers",async()=>{
 const controller=new AbortController();const reason=new DOMException("Cancelled","AbortError");
 const fetcher=vi.fn().mockImplementation(()=>{controller.abort(reason);return Promise.resolve(new Response("edge",{status:429}));});vi.stubGlobal("fetch",fetcher);
 await expect(intelligenceApi("/sync/run","POST",{},controller.signal)).rejects.toBe(reason);expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([200,503])("preserves the exact caller reason from an actual status %s body stream",async(status)=>{
 const controller=new AbortController();const reason=new Error("caller reason");
 let bodyController!:ReadableStreamDefaultController<Uint8Array>;
 const body=new ReadableStream<Uint8Array>({start(stream){bodyController=stream;stream.enqueue(new TextEncoder().encode('{"partial":'));}});
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body,{status})));
 const pending=intelligenceApi("/applications","PATCH",{},controller.signal);
 const assertion=expect(pending).rejects.toBe(reason);
 await new Promise(resolve=>setTimeout(resolve,0));controller.abort(reason);bodyController.error(new DOMException("Reader cancelled","AbortError"));
 await assertion;expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([[200,"GET"],[200,"PATCH"],[503,"GET"],[503,"PATCH"]] as const)("normalizes interrupted status %s streams for %s without replay or private diagnostics",async(status,method)=>{
 let bodyController!:ReadableStreamDefaultController<Uint8Array>;
 const body=new ReadableStream<Uint8Array>({start(stream){bodyController=stream;stream.enqueue(new TextEncoder().encode('{"partial":'));}});
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body,{status})));
 const pending=intelligenceApi("/applications",method,method==="PATCH"?{}:undefined);
 const assertion=expect(pending).rejects.toThrow(method==="PATCH"?"outcome is unconfirmed":"Check your connection");
 await new Promise(resolve=>setTimeout(resolve,0));bodyController.error(new TypeError("private transport marker"));await assertion;expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(["GET","PATCH"])("normalizes complete malformed successful JSON for %s",async(method)=>{
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("<html>private diagnostic</html>",{status:200})));
 await expect(intelligenceApi("/applications",method)).rejects.toThrow(method==="PATCH"?"Check the app state":"Check your connection");expect(fetch).toHaveBeenCalledTimes(1);
});
it("uses readable 429 headers even when its actual body stream is interrupted",async()=>{
 const body=new ReadableStream<Uint8Array>({start(stream){stream.error(new TypeError("private edge marker"));}});
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body,{status:429})));
 await expect(intelligenceApi("/applications","PATCH",{})).rejects.toThrow("wait at least 60 seconds");expect(fetch).toHaveBeenCalledTimes(1);
});
it("preserves a distinct caller cancellation reason when fetch throws a reader AbortError",async()=>{
 const controller=new AbortController();const reason=new Error("caller reason");
 vi.stubGlobal("fetch",vi.fn().mockImplementation(()=>{controller.abort(reason);return Promise.reject(new DOMException("Reader cancelled","AbortError"));}));
 await expect(intelligenceApi("/applications","PATCH",{},controller.signal)).rejects.toBe(reason);expect(fetch).toHaveBeenCalledTimes(1);
});

it("preserves caller cancellation with an actual readable 429 stream",async()=>{
 const controller=new AbortController();const reason=new Error("caller reason");
 const body=new ReadableStream<Uint8Array>({start(stream){stream.enqueue(new TextEncoder().encode("<html>private edge</html>"));stream.close();}});
 vi.stubGlobal("fetch",vi.fn().mockImplementation(()=>{controller.abort(reason);return Promise.resolve(new Response(body,{status:429}));}));
 await expect(intelligenceApi("/applications","PATCH",{},controller.signal)).rejects.toBe(reason);expect(fetch).toHaveBeenCalledTimes(1);
});
