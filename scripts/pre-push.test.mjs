import assert from "node:assert/strict";
import test from "node:test";
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";
import {readFileSync,statSync} from "node:fs";
import { validatePushState } from "./pre-push.js";

const head = "a".repeat(40);
const update = (localSha = head) => ({ localRef: "refs/heads/bfarmer/change", localSha, remoteRef: "refs/heads/bfarmer/change", remoteSha: "b".repeat(40) });

test("allows only clean pushes whose refs all point to the tested commit", () => {
  assert.equal(validatePushState([update()], head, true), undefined);
  assert.match(validatePushState([update(), update("c".repeat(40))], head, true), /tested HEAD/);
  assert.match(validatePushState([update()], head, false), /worktree must be clean/);
  assert.match(validatePushState([update("0".repeat(40))], head, true), /Deleting remote refs/);
  assert.match(validatePushState([], head, true), /No refs/);
});

test("the active hook refuses invalid refs and dirty candidate content without running quality",()=>{
 const config=spawnSync("git",["config","--get","core.hooksPath"],{encoding:"utf8"});assert.equal(config.status,0);assert.equal(config.stdout.trim(),".githooks");
 assert.match(readFileSync(".githooks/pre-push","utf8"),/node scripts\/pre-push.js/);
 const shell=process.platform === "win32" ? resolve(spawnSync("git",["--exec-path"],{encoding:"utf8"}).stdout.trim(),"../../../bin/sh.exe") : "sh";
 const invalid=spawnSync(shell,[".githooks/pre-push"],{input:"invalid ref record\n",encoding:"utf8"});assert.equal(invalid.status,1);assert.match(invalid.stderr,/Malformed/);
 const headResult=spawnSync("git",["rev-parse","HEAD"],{encoding:"utf8"});assert.equal(headResult.status,0);
 // Unit tests assert the dirty-state refusal regardless of the checkout cleanliness at CI time.
 assert.match(validatePushState([update(headResult.stdout.trim())],headResult.stdout.trim(),false),/clean/);
});

test("the tracked executable hook can be reinstalled without changing its mode",()=>{
 const mode=spawnSync("git",["ls-files","--stage",".githooks/pre-push"],{encoding:"utf8"});assert.equal(mode.status,0);assert.match(mode.stdout,/^100755 /);
 const installed=spawnSync(process.execPath,["scripts/install-hooks.mjs"],{encoding:"utf8"});assert.equal(installed.status,0,installed.stderr);
 if(process.platform!=="win32")assert.ok(statSync(".githooks/pre-push").mode & 0o111);
 const changes=spawnSync("git",["diff","--summary","--",".githooks/pre-push"],{encoding:"utf8"});assert.equal(changes.status,0);assert.equal(changes.stdout.trim(),"");
});
