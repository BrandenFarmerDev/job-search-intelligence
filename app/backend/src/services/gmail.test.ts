import { afterEach, describe, expect, it, vi } from "vitest";
import { assertGmailDrained, beginGmail, completeGmail, extractGmailText, gmailDiscoverPage, gmailJson, gmailRefreshLabels, reserveGmailWorkflowStep } from "./gmail";
import { fixture } from "../test/fixtures";
import { encrypt, Problem } from "./security";

function ready(env:Env){Object.assign(env,{GMAIL_CLIENT_ID:"synthetic-client",GMAIL_CLIENT_SECRET:"synthetic-secret",GMAIL_REDIRECT_URI:"https://api.example.test/api/job-intelligence/connections/gmail/callback",GMAIL_MAILBOX:"synthetic-owner@gmail.com",GMAIL_SYNTHETIC_MAILBOX:"synthetic-owner@gmail.com",ENVIRONMENT_NAME:"preview"});}
afterEach(()=>vi.unstubAllGlobals());

describe("private Gmail OAuth boundary",()=>{
  it("binds one-use PKCE state to owner, environment and current epochs and stores only an encrypted read-only grant",async()=>{
    const {env,db,close}=fixture();ready(env);let tokens=0;vi.stubGlobal("fetch",vi.fn(async(url:RequestInfo|URL)=>{
      if(String(url)==="https://oauth2.googleapis.com/token"){tokens++;return Response.json({access_token:"access-token",refresh_token:"refresh-secret",scope:"https://www.googleapis.com/auth/gmail.readonly"});}
      return Response.json({emailAddress:"synthetic-owner@gmail.com"});
    }));
    const begin=await beginGmail(env,"owner-sub");const cookie=begin.headers.get("Set-Cookie")!;const authorization=new URL((await begin.json() as {authorizationUrl:string}).authorizationUrl);
    expect(authorization.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");expect(authorization.searchParams.get("access_type")).toBe("offline");expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const callback=new Request(`https://api.example.test/api/job-intelligence/connections/gmail/callback?code=synthetic-code&state=${authorization.searchParams.get("state")}`,{headers:{Cookie:cookie.split(";")[0]}});
    const response=await completeGmail(callback,env,"owner-sub");expect(response.status).toBe(303);expect(response.headers.get("Location")).toBe(`${env.ALLOWED_ORIGIN}?gmail=connected`);
    const row=await db.prepare("SELECT mailbox,encrypted_refresh_token,granted_scopes FROM gmail_connections").first<{mailbox:string;encrypted_refresh_token:string;granted_scopes:string}>();
    expect(row?.mailbox).toBe("synthetic-owner@gmail.com");expect(row?.encrypted_refresh_token).not.toContain("refresh-secret");expect(row?.granted_scopes).toBe("https://www.googleapis.com/auth/gmail.readonly");
    await expect(completeGmail(callback,env,"owner-sub")).rejects.toMatchObject({code:"expired_gmail_oauth_state"});expect(tokens).toBe(1);close();
  });
  it("rejects a broader grant without saving credentials",async()=>{
    const {env,db,close}=fixture();ready(env);vi.stubGlobal("fetch",vi.fn(async(url:RequestInfo|URL)=>String(url)==="https://oauth2.googleapis.com/token"
      ?Response.json({access_token:"access-token",refresh_token:"refresh-secret",scope:"https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify"})
      :Response.json({emailAddress:"wrong@gmail.com"})));
    const begin=await beginGmail(env,"owner-sub");const state=new URL((await begin.json() as {authorizationUrl:string}).authorizationUrl).searchParams.get("state")!;
    const request=new Request(`https://api.example.test/callback?code=code&state=${state}`,{headers:{Cookie:`job_gmail_oauth=${state}`}});
    await expect(completeGmail(request,env,"owner-sub")).rejects.toMatchObject({code:"gmail_scope_invalid"});
    expect(await db.prepare("SELECT id FROM gmail_connections").first()).toBeNull();close();
  });
  it("never stores a read-only token when Gmail profile binding returns another account",async()=>{
    const {env,db,close}=fixture();ready(env);vi.stubGlobal("fetch",vi.fn(async(url:RequestInfo|URL)=>String(url)==="https://oauth2.googleapis.com/token"
      ?Response.json({access_token:"access-token",refresh_token:"refresh-secret",scope:"https://www.googleapis.com/auth/gmail.readonly"})
      :Response.json({emailAddress:"other@gmail.com"})));
    const begin=await beginGmail(env,"owner-sub");const state=new URL((await begin.json() as {authorizationUrl:string}).authorizationUrl).searchParams.get("state")!;
    const request=new Request(`https://api.example.test/callback?code=code&state=${state}`,{headers:{Cookie:`job_gmail_oauth=${state}`}});
    await expect(completeGmail(request,env,"owner-sub")).rejects.toMatchObject({code:"gmail_mailbox_mismatch"});expect(await db.prepare("SELECT id FROM gmail_connections").first()).toBeNull();close();
  });
  it("refuses the production mailbox in preview and streams provider payloads under a hard byte limit",async()=>{
    const {env,close}=fixture();ready(env);env.GMAIL_MAILBOX="branden.farmer.dev@gmail.com";
    await expect(beginGmail(env,"owner-sub")).rejects.toMatchObject({code:"gmail_synthetic_mailbox_required"});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("x".repeat(8192))));
    await expect(gmailJson("https://gmail.googleapis.com/gmail/v1/users/me/profile","token")).rejects.toBeInstanceOf(Problem);
    close();
  });
  it("reserves bounded quota before root-label-only paginated discovery and persists candidates with its cursor",async()=>{
    const {env,db,close}=fixture();ready(env);Object.assign(env,{GMAIL_ENABLED:"true",GMAIL_SYNC_ENABLED:"true",MAIL_SOURCE:"gmail",HISTORICAL_START_DATE:"2026-09-30T07:00:00Z"});
    const generation=(await db.prepare("SELECT value FROM app_metadata WHERE key='gmail_connection_generation'").first<{value:string}>())!.value;
    const secret=await encrypt("refresh-token","MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",`gmail:synthetic-owner@gmail.com:preview:connection`);
    await db.batch([
      db.prepare("INSERT INTO app_metadata(key,value) VALUES('mail_source','gmail') ON CONFLICT(key) DO UPDATE SET value='gmail'"),
      db.prepare("INSERT INTO app_metadata(key,value) VALUES('gmail_sync_paused','false') ON CONFLICT(key) DO UPDATE SET value='false'"),
      db.prepare("INSERT INTO sync_locks VALUES('daily','run',?)").bind(Date.now()+3600000),
      db.prepare("INSERT INTO gmail_connections VALUES('connection','synthetic-owner@gmail.com',?,?,?,?,'connected',?)").bind(secret,new Date().toISOString(),new Date().toISOString(),generation,"https://www.googleapis.com/auth/gmail.readonly"),
    ]);
    vi.stubGlobal("fetch",vi.fn(async(url:RequestInfo|URL)=>{
      const value=String(url);
      if(value==="https://oauth2.googleapis.com/token")return Response.json({access_token:"access"});
      if(value==="https://gmail.googleapis.com/gmail/v1/users/me/labels")return Response.json({labels:[{id:"root-id",name:"Job search"},{id:"receipt-id",name:"Job search/Application receipts"},{id:"follow-id",name:"Job search/Recruiter follow ups"},{id:"interview-id",name:"Job search/Interviews"},{id:"offer-id",name:"Job search/Offers"},{id:"reject-id",name:"Job search/Rejections"},{id:"alert-id",name:"Job search/Job alerts"},{id:"review-id",name:"Job search/Review"}]});
      if(value.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")){const query=new URL(value);expect(query.searchParams.getAll("labelIds")).toEqual(["root-id"]);expect(query.searchParams.get("includeSpamTrash")).toBe("true");expect(query.searchParams.get("maxResults")).toBe("1");return Response.json({messages:[{id:"candidate-1",threadId:"thread-1"}],nextPageToken:"opaque-next"});}
      throw new Error("unexpected provider endpoint");
    }));
    const epoch=(await db.prepare("SELECT value FROM app_metadata WHERE key='job_data_generation'").first<{value:string}>())!.value;
    await gmailRefreshLabels(env,"run",epoch,generation);
    const result=await gmailDiscoverPage(env,"run",epoch,generation);
    expect(result).toEqual({done:false,discovered:1});expect(await db.prepare("SELECT stage FROM gmail_candidates WHERE gmail_id='candidate-1'").first()).toMatchObject({stage:"metadata"});expect(await db.prepare("SELECT cursor FROM gmail_checkpoints WHERE name='baseline'").first()).toMatchObject({cursor:"opaque-next"});
    expect(await db.prepare("SELECT units,calls,lists FROM gmail_budget").first()).toMatchObject({units:6,calls:2,lists:1});expect(await db.prepare("SELECT value FROM app_metadata WHERE key='gmail_label_ids'").first()).not.toBeNull();close();
  });
});

describe("bounded MIME projection",()=>{
  it("extracts plain text and headers without retaining attachment content, and marks an external text part for review",()=>{
    const plain=extractGmailText({id:"one",threadId:"thread",payload:{mimeType:"multipart/mixed",headers:[{name:"Subject",value:"Applied"}],parts:[{mimeType:"text/plain",body:{data:btoa("Thank you for applying")}}, {mimeType:"application/pdf",filename:"resume.pdf",body:{size:10}}]}});
    expect(plain.text).toBe("Thank you for applying");expect(plain.headers.subject).toBe("Applied");expect(plain.unsupported).toBe(false);expect(plain.textAttachments).toEqual([]);
    const external=extractGmailText({id:"two",threadId:"thread",payload:{mimeType:"text/plain",body:{attachmentId:"attachment"}}});expect(external.unsupported).toBe(false);expect(external.textAttachments).toEqual([{mimeType:"text/plain",attachmentId:"attachment",charset:"utf-8"}]);
    const attachmentOnly=extractGmailText({id:"three",threadId:"thread",payload:{mimeType:"multipart/mixed",parts:[{mimeType:"application/pdf",filename:"resume.pdf",body:{size:3}}]}});expect(attachmentOnly.unsupported).toBe(true);
  });
  it("rejects MIME nesting and part counts over the accepted safety envelope",()=>{
    let part={mimeType:"multipart/mixed"} as {mimeType:string;parts?:typeof part[]};for(let i=0;i<21;i++)part={mimeType:"multipart/mixed",parts:[part]};
    expect(()=>extractGmailText({id:"deep",threadId:"thread",payload:part})).toThrowError("gmail_mime_unsupported");
  });
});

describe("persistent Gmail usage caps",()=>{
  it("enforces a durable daily step ceiling for provider, classification and Sheets phases",async()=>{
    const {env,db,close}=fixture();const day=new Date().toISOString().slice(0,10);
    await db.prepare("INSERT INTO gmail_budget(day,steps) VALUES(?,199)").bind(day).run();
    await reserveGmailWorkflowStep(env);
    await expect(reserveGmailWorkflowStep(env)).rejects.toMatchObject({code:"gmail_daily_step_budget_exhausted"});
    expect(await db.prepare("SELECT steps FROM gmail_budget WHERE day=?").bind(day).first()).toMatchObject({steps:200});close();
  });
  it("refuses successful completion while a durable retry or provider cooldown remains",async()=>{
    const {env,db,close}=fixture();env.GMAIL_MAILBOX="synthetic-owner@gmail.com";await db.prepare("INSERT INTO gmail_candidates(mailbox,gmail_id,thread_id,stage,created_at,updated_at) VALUES('synthetic-owner@gmail.com','retry','thread','body','now','now')").run();
    await expect(assertGmailDrained(env)).rejects.toMatchObject({code:"gmail_backlog_pending"});
    await db.prepare("UPDATE gmail_candidates SET stage='done' WHERE gmail_id='retry'").run();await assertGmailDrained(env);close();
  });
});
