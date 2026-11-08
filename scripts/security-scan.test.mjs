import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import test from "node:test";
import {assertCleanSecrets,scanSecrets} from "./secret-scan.mjs";
test("secret reports fail closed on findings or missing shape",()=>{
 assert.throws(()=>scanSecrets(["missing-jobs-artifact-directory"]));
 assert.doesNotThrow(()=>assertCleanSecrets([]));for(const invalid of [null,{},[{RuleID:"anything"}]])assert.throws(()=>assertCleanSecrets(invalid));
 const result=spawnSync(process.execPath,["scripts/secret-scan.mjs","."],{env:{...process.env,GITLEAKS_BINARY:"missing-jobs-gitleaks"},encoding:"utf8"});assert.equal(result.status,1);
});
test("real scanner detects a synthetic credential in source and a built artifact without logging it",()=>{
 const directory=mkdtempSync(join(tmpdir(),"jobs-scanner-"));
 try{
  const secret=["ghp","_","aB3dE6gH9jK2mN5pQ8sT1vX4zA7cD0fG3hIx"].join("");
  for(const file of ["settings.jsonc","built.js"])writeFileSync(join(directory,file),`const token = "${secret}";`);
  const report=join(directory,"result.json");const result=spawnSync(process.env.GITLEAKS_BINARY||"gitleaks",["dir","--config",resolve(".gitleaks.toml"),"--redact","--no-banner","--report-format","json","--report-path",report,directory],{encoding:"utf8"});
  assert.ifError(result.error);assert.equal(result.status,1);assert.doesNotMatch(result.stdout+result.stderr,new RegExp(secret));const findings=JSON.parse(readFileSync(report,"utf8"));assert.ok(findings.some(({File})=>File.endsWith("settings.jsonc")));assert.ok(findings.some(({File})=>File.endsWith("built.js")));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
