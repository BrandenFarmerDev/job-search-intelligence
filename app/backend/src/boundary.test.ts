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
 expect((await worker.fetch(request("POST"),env)).status).toBe(403);expect((await worker.fetch(request("OPTIONS",env.ALLOWED_ORIGIN),env)).status).toBe(204);
 vi.mocked(authorize).mockRejectedValue(new Problem(401,"authentication_required"));expect((await worker.fetch(request(),env)).status).toBe(401);
 vi.mocked(authorize).mockResolvedValue("owner");vi.mocked(intelligenceRoute).mockResolvedValue(Response.json({ok:true}));expect((await worker.fetch(request(),env)).status).toBe(200);
 vi.mocked(intelligenceRoute).mockRejectedValue(new Error("private data"));const response=await worker.fetch(request(),env);expect(response.status).toBe(500);expect(await response.text()).not.toContain("private data");close();
});
it("schedules only explicitly enabled sync",async()=>{
 const {env,db,close}=fixture();await worker.scheduled({} as ScheduledController,env);expect(env.JOB_SYNC.create).not.toHaveBeenCalled();env.SYNC_ENABLED="true";await worker.scheduled({} as ScheduledController,env);expect(env.JOB_SYNC.create).toHaveBeenCalledWith({params:{trigger:"scheduled"}});vi.mocked(env.JOB_SYNC.create).mockClear();await db.prepare("INSERT INTO app_metadata VALUES('sync_paused','true')").run();await worker.scheduled({} as ScheduledController,env);expect(env.JOB_SYNC.create).not.toHaveBeenCalled();close();
});
