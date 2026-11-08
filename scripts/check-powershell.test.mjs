import assert from "node:assert/strict";
import test from "node:test";
import {checkPowerShell} from "./check-powershell.mjs";

test("mandatory PowerShell checks fail closed without an engine locally or in CI",()=>{
 for(const environment of [{},{CI:"true"}]){
  const messages=[];const probes=[];
  const status=checkPowerShell({environment,spawn:(engine)=>{probes.push(engine);return {status:null,error:new Error("unavailable")};},log:message=>messages.push(message)});
  assert.equal(status,1);assert.deepEqual(probes,["pwsh","powershell.exe"]);assert.match(messages.join("\n"),/failed.*mandatory checks cannot run/);assert.doesNotMatch(messages.join("\n"),/skipped/);
 }
});
test("available pwsh executes the workload and existing checks without claiming Windows evidence",()=>{
 const calls=[];const messages=[];
 const status=checkPowerShell({platform:"linux",environment:{PSMODULEPATH:"fixture"},spawn:(engine,args)=>{calls.push({engine,args});return {status:engine==="pwsh"?0:null,stdout:"",stderr:""};},log:message=>messages.push(message)});
 assert.equal(status,0);assert.ok(calls.some(({args})=>args.some(arg=>arg.endsWith("test-api-rate-workload.ps1"))));
 assert.ok(calls.some(({args})=>args.some(arg=>arg.endsWith("test-outlook-run-lifecycle.ps1"))));
 assert.ok(!calls.some(({args})=>args.some(arg=>arg.endsWith("measure-outlook-coverage.ps1"))));assert.match(messages.join("\n"),/coverage unmeasured.*Windows PowerShell/);
});
test("a failed required workload fails the gate and native Windows preserves coverage checks",()=>{
 const calls=[];
 const status=checkPowerShell({platform:"win32",environment:{PSMODULEPATH:"ps7-only",FIXTURE:"value"},spawn:(engine,args,options)=>{
  calls.push({engine,args,options});const workload=args.some(arg=>arg.endsWith("test-api-rate-workload.ps1"));return {status:workload?1:0,stdout:"synthetic failure",stderr:""};
 },log:()=>{}});
 assert.equal(status,1);assert.ok(calls.some(({args})=>args.some(arg=>arg.endsWith("measure-outlook-coverage.ps1"))));
 for(const call of calls.filter(({engine})=>engine==="powershell.exe"))assert.equal(call.options.env.PSMODULEPATH,undefined);
});
