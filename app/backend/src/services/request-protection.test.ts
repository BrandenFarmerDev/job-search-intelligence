import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { protectRequest } from "./request-protection";
import { fixture } from "../test/fixtures";

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const request = (ip?: string) => new Request("https://api.example/api/health?token=private", { headers: ip ? { "CF-Connecting-IP": ip } : {} });
const allowed = () => vi.fn().mockResolvedValue({success:true});
async function keyFor(ip?: string) { const limit=allowed(); await protectRequest(request(ip),{limit}); return limit.mock.calls[0][0].key; }

describe("API admission", () => {
 it("hashes only bounded canonical trusted IP, ignoring caller identity and route",async()=>{
  const limit=allowed();const first=request("192.0.2.1");await protectRequest(first,{limit});
  await protectRequest(new Request("https://api.example/random?other=1",{method:"DELETE",headers:{"CF-Connecting-IP":"192.0.2.1","X-Forwarded-For":"203.0.113.1",Authorization:"private"}}),{limit});
  expect(limit).toHaveBeenCalledTimes(2);expect(limit.mock.calls[0][0]).toEqual(limit.mock.calls[1][0]);expect(limit.mock.calls[0][0].key).toMatch(/^api:v1:[a-f0-9]{64}$/);
  expect(await keyFor("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe(await keyFor("2001:db8::1"));expect(await keyFor("192.0.2.2")).not.toBe(await keyFor("192.0.2.1"));
 });
 it("collapses every invalid or missing literal into one sentinel",async()=>{
  const sentinel=await keyFor();
  for(const ip of ["x".repeat(46),"192.168.001.1","256.1.1.1","1.2.3","host.example","1.2.3.4:80","[::1]","fe80::1%eth0","1.2.3.4,5.6.7.8","gg::1","::::"]){expect(await keyFor(ip)).toBe(sentinel);}
 });
 it.each([undefined,null,{}, {success:1},{success:"true"}])("fails closed for malformed result %j",async(outcome)=>{
  const response=await protectRequest(request(),{limit:vi.fn().mockResolvedValue(outcome)});expect(response?.status).toBe(503);expect(response?.headers.get("Retry-After")).toBe("60");
 });
 it("handles missing, synchronous and asynchronous binding failures without sensitive diagnostics",async()=>{
  for(const binding of [undefined,{limit:()=>{throw new Error("private-token");}},{limit:()=>Promise.reject(new Error("private-token"))}]){
   expect((await protectRequest(request(),binding))?.status).toBe(503);
  }
  expect(console.warn).toHaveBeenCalledTimes(3);expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/private-token|token=|api\/health/);
 });
 it.each(["GET","HEAD","OPTIONS","POST","PATCH","DELETE"])("denies %s before auth, body and downstream effects on any route",async(method)=>{
  const {env,close}=fixture();try{
   const limit=vi.fn().mockResolvedValue({success:false});env.API_RATE_LIMITER={limit};
   const req=new Request("https://api.example/api/job-intelligence/local-outlook/import",{method,headers:{Origin:env.ALLOWED_ORIGIN},...(["POST","PATCH","DELETE"].includes(method)?{body:"not-json"}:{})});
   const read=vi.spyOn(req,"text");const db=vi.spyOn(env.JOB_SEARCH_DB,"prepare");
   const response=await worker.fetch(req,env);expect(response.status).toBe(429);expect(limit).toHaveBeenCalledTimes(1);expect(read).not.toHaveBeenCalled();expect(db).not.toHaveBeenCalled();expect(env.JOB_SYNC.create).not.toHaveBeenCalled();
   expect(response.headers.get("Cache-Control")).toBe("no-store");expect(response.headers.get("Access-Control-Allow-Origin")).toBe(env.ALLOWED_ORIGIN);expect(response.headers.get("Access-Control-Expose-Headers")).toContain("X-Job-Data-Generation");expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
   if(method==="HEAD")expect(await response.text()).toBe("");else expect(await response.json()).toMatchObject({error:"rate_limited"});
  }finally{close();}
 });
 it("counts denied foreign origins and unknown routes first",async()=>{
  const {env,close}=fixture();try{const limit=vi.fn().mockResolvedValue({success:false});env.API_RATE_LIMITER={limit};expect((await worker.fetch(new Request("https://api.example/unknown",{headers:{Origin:"https://evil.example"}}),env)).status).toBe(429);expect(limit).toHaveBeenCalledTimes(1);}finally{close();}
 });
 it.each(["resolve","reject"])("times out and never dispatches on late %s",async(late)=>{
  vi.useFakeTimers();vi.spyOn(crypto.subtle,"digest").mockResolvedValue(new Uint8Array(32).buffer);let resolve!:(value:{success:boolean})=>void;let reject!:(reason:Error)=>void;
  const limit=vi.fn().mockImplementation(()=>new Promise((yes,no)=>{resolve=yes;reject=no;}));
  const {env,close}=fixture();try{
   env.API_RATE_LIMITER={limit};const db=vi.spyOn(env.JOB_SEARCH_DB,"prepare");let settled=false;
   const pending=worker.fetch(new Request("https://api.example/api/job-intelligence/dashboard"),env).then(response=>{settled=true;return response;});
   await vi.advanceTimersByTimeAsync(0);expect(limit).toHaveBeenCalledTimes(1);
   await vi.advanceTimersByTimeAsync(999);expect(settled).toBe(false);
   await vi.advanceTimersByTimeAsync(1);expect((await pending).status).toBe(503);
   if(late==="resolve")resolve({success:true});else reject(new Error("private-late"));
   await vi.advanceTimersByTimeAsync(0);expect(db).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);

  }finally{close();}
 });
});

it("measures warmed local admission overhead with an immediate native-binding mock",async()=>{
 const limit=allowed();const req=request("192.0.2.10");for(let i=0;i<50;i++)await protectRequest(req,{limit});
 const samples:number[]=[];for(let i=0;i<500;i++){const start=performance.now();await protectRequest(req,{limit});samples.push(performance.now()-start);}
 samples.sort((a,b)=>a-b);const p95=samples[Math.ceil(samples.length*.95)-1];
 mkdirSync("../../reports",{recursive:true});writeFileSync("../../reports/api-rate-local-latency.json",JSON.stringify({benchmark:"local_guard",runtime:process.version,platform:process.platform,warmup:50,samples:500,p50:samples[249],p95,max:samples[499],binding:"immediate success mock",productionLatency:false}));expect(p95).toBeLessThan(10);expect(limit).toHaveBeenCalledTimes(550);
});

it("does not count scheduled events as HTTP requests",async()=>{
 const {env,close}=fixture();try{const limit=allowed();env.API_RATE_LIMITER={limit};env.SYNC_ENABLED="false";await worker.scheduled({} as ScheduledController,env);expect(limit).not.toHaveBeenCalled();}finally{close();}
});
