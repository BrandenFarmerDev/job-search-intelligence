import { afterEach, expect, it, vi } from "vitest";
import worker from "./index";
import { authorize, Problem } from "./services/security";
import { intelligenceRoute } from "./routes/intelligence";
import { fixture } from "./test/fixtures";
vi.mock("./services/security",async(importOriginal)=>({...await importOriginal<typeof import("./services/security")>(),authorize:vi.fn()}));
vi.mock("./routes/intelligence",()=>({intelligenceRoute:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
it("protects private routes including CORS and missing origin mutations",async()=>{
 const {env,close}=fixture();const request=(method="GET",origin?:string)=>new Request("https://api.example/api/job-intelligence/dashboard",{method,headers:origin?{Origin:origin}:{}});
 vi.mocked(authorize).mockRejectedValue(new Problem(401,"authentication_required"));expect((await worker.fetch(request("POST"),env)).status).toBe(403);expect((await worker.fetch(request("OPTIONS",env.ALLOWED_ORIGIN),env)).status).toBe(204);
 expect((await worker.fetch(request(),env)).status).toBe(401);
 vi.mocked(authorize).mockResolvedValue({kind:"owner",id:"owner"});vi.mocked(intelligenceRoute).mockResolvedValue(Response.json({ok:true}));expect((await worker.fetch(request(),env)).status).toBe(200);
 vi.mocked(intelligenceRoute).mockRejectedValue(new Error("private data"));const response=await worker.fetch(request(),env);expect(response.status).toBe(500);expect(await response.text()).not.toContain("private data");close();
});
it("limits the automation principal to an exact route allowlist without an Origin",async()=>{
 const {env,close}=fixture();const base="https://api.example/api/job-intelligence";
 const call=(path:string,method="POST",origin?:string)=>worker.fetch(new Request(`${base}${path}`,{method,headers:origin?{Origin:origin}:{}}),env);
 vi.mocked(intelligenceRoute).mockResolvedValue(Response.json({ok:true}));
 vi.mocked(authorize).mockResolvedValue({kind:"automation",id:"automation"});
 for(const [path,method] of [["/local-outlook/import","POST"],["/sync/run","POST"],["/sync-runs","GET"]])expect((await call(path,method)).status).toBe(200);
 expect(vi.mocked(intelligenceRoute).mock.calls[0][2]).toEqual({kind:"automation",id:"automation"});
 for(const [path,method] of [["/dashboard","GET"],["/data","DELETE"],["/applications","POST"],["/sync/run/","POST"],["/sync-runs","POST"],["/local-outlook/import","GET"],["/x/sync/run","POST"],["/sync-runs","HEAD"],["/sync-runs/","GET"],["/sync%2Druns","GET"],["/local-outlook/import/","POST"],["/local-outlook%2Fimport","POST"]]){const response=await call(path,method);expect(response.status).toBe(403);expect((await response.json() as {error:string}).error).toBe("automation_route_forbidden");}
 for(const origin of [env.ALLOWED_ORIGIN,"https://evil.example"])expect((await call("/sync/run","POST",origin)).status).toBe(403);
 vi.mocked(intelligenceRoute).mockClear();
 vi.mocked(authorize).mockResolvedValue({kind:"owner",id:"owner"});
 expect((await call("/sync/run","POST")).status).toBe(403);expect((await call("/sync/run","POST",env.ALLOWED_ORIGIN)).status).toBe(200);expect(intelligenceRoute).toHaveBeenCalledTimes(1);
 vi.mocked(authorize).mockRejectedValue(new Problem(401,"authentication_required"));expect((await call("/sync/run")).status).toBe(403);expect((await call("/sync-runs","GET")).status).toBe(401);close();
});
it("schedules only explicitly enabled sync",async()=>{
 const {env,db,close}=fixture();await worker.scheduled({} as ScheduledController,env);expect(env.JOB_SYNC.create).not.toHaveBeenCalled();env.SYNC_ENABLED="true";await worker.scheduled({} as ScheduledController,env);expect(env.JOB_SYNC.create).toHaveBeenCalledWith({params:{trigger:"scheduled"}});vi.mocked(env.JOB_SYNC.create).mockClear();await db.prepare("INSERT INTO app_metadata VALUES('sync_paused','true')").run();await worker.scheduled({} as ScheduledController,env);expect(env.JOB_SYNC.create).not.toHaveBeenCalled();close();
});
