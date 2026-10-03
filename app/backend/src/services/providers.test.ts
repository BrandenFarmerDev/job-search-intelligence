import { afterEach, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { beginMicrosoft, completeMicrosoft, graphPage, initialDelta, microsoftToken, projectMessage, validateDelta } from "./microsoft";
import { dateValue, fetchSheet, normalize, parseRows } from "./sheets";
import { digest, encrypt } from "./security";
import { ingestLocalOutlookBatch, parseLocalOutlookBatch } from "./local-outlook";
import { emailReferenceId, normalizeInternetMessageId } from "./email-identity";
import { fixture, sheetData, sheetHeaders } from "../test/fixtures";
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it("binds OAuth to owner, PKCE, secure cookie, one-use state and mailbox identity",async()=>{
 const {env,db,close}=fixture();const start=await beginMicrosoft(env,"owner-sub");const {url}=await start.json() as {url:string};const authorize=new URL(url);
 expect(authorize.searchParams.get("scope")).toBe("offline_access User.Read Mail.Read");expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");expect(start.headers.get("Set-Cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
 const state=authorize.searchParams.get("state")!;
 const callback=(selectedState=state,ownerCookie=state)=>new Request(`${env.MICROSOFT_REDIRECT_URI}?code=auth-code&state=${selectedState}`,{headers:{Cookie:`other=x; job_oauth=${ownerCookie}`}});
 await expect(completeMicrosoft(callback(state,"wrong"),env,"owner-sub")).rejects.toMatchObject({code:"invalid_oauth_state"});
 await expect(completeMicrosoft(callback(),env,"other-owner")).rejects.toMatchObject({code:"expired_oauth_state"});
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({access_token:"access",refresh_token:"refresh",scope:"Mail.Read User.Read"})).mockResolvedValueOnce(Response.json({id:"mailbox",mail:env.OWNER_EMAIL}));vi.stubGlobal("fetch",fetcher);
 expect((await completeMicrosoft(callback(),env,"owner-sub")).status).toBe(303);
 expect(fetcher.mock.calls[0][1].body.toString()).toContain("code_verifier=");const connection=await db.prepare("SELECT encrypted_credentials FROM connections").first<{encrypted_credentials:string}>();expect(connection?.encrypted_credentials).not.toContain("refresh");
 await expect(completeMicrosoft(callback(),env,"owner-sub")).rejects.toMatchObject({code:"expired_oauth_state"});
 close();
});
it("rejects incomplete setup, untrusted mailbox, unexpected sending permission, and missing refresh tokens",async()=>{
 const {env,close}=fixture();await expect(beginMicrosoft({...env,MICROSOFT_CLIENT_ID:""},"owner")).rejects.toMatchObject({status:503});
 for(const response of [{access_token:"access",scope:"Mail.Send",refresh_token:"r"},{access_token:"access"},{access_token:"access",refresh_token:"r"}]){
  const start=await beginMicrosoft(env,"owner");const state=new URL((await start.json() as {url:string}).url).searchParams.get("state")!;
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json(response)).mockResolvedValueOnce(Response.json({id:"x",userPrincipalName:"other@example.com"})));
  await expect(completeMicrosoft(new Request(`${env.MICROSOFT_REDIRECT_URI}?state=${state}&code=x`,{headers:{Cookie:`job_oauth=${state}`}}),env,"owner")).rejects.toThrow();
 }
 await expect(completeMicrosoft(new Request(env.MICROSOFT_REDIRECT_URI),env,"owner")).rejects.toMatchObject({status:400});close();
});
it("refreshes credentials and rotates encrypted refresh token",async()=>{
 const {env,db,close}=fixture();expect(await microsoftToken(env)).toBeNull();const encrypted=await encrypt("refresh",env.TOKEN_ENCRYPTION_KEY,"microsoft:account");
 await db.prepare("INSERT INTO connections VALUES('microsoft','account',?,?,?)").bind(encrypted,"date","date").run();
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({access_token:"new-access",refresh_token:"new-refresh"})));
 expect(await microsoftToken(env)).toEqual({account:"account",token:"new-access"});
 vi.mocked(fetch).mockResolvedValue(Response.json({access_token:"next-access"}));expect((await microsoftToken(env))?.token).toBe("next-access");close();
});
it("validates Graph URLs, bounded message pages and immutable-ID headers",async()=>{
 const url=initialDelta("inbox","2026-01-01");expect(new URL(url).searchParams.get("$filter")).toContain("2026-01-01");expect(validateDelta(url,"inbox")).toBe(url);
 for(const bad of ["https://evil.example/v1.0/me/mailFolders/inbox/messages/delta",url.replace("inbox","sentitems"),url+"#x","https://user:pass@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta"])expect(()=>validateDelta(bad,"inbox")).toThrow();
 for(const date of ["bad","2026-99-99"])expect(()=>initialDelta("inbox",date)).toThrow();
 const fetcher=vi.fn().mockResolvedValue(Response.json({value:[{id:"immutable"}],"@odata.deltaLink":url}));vi.stubGlobal("fetch",fetcher);expect((await graphPage(url,"inbox","token")).value).toHaveLength(1);
 expect(fetcher.mock.calls[0][1].headers.Prefer).toContain('IdType="ImmutableId"');
 for(const value of [{value:[] ,"@odata.nextLink":"https://evil.example"},{value:[{}]},{value:"bad"}]){fetcher.mockResolvedValue(Response.json(value));await expect(graphPage(url,"inbox","token")).rejects.toThrow();}
 expect(projectMessage({id:"i",sentDateTime:"2026-01-01",webLink:"https://evil.example"},"sentitems")).toMatchObject({webLink:"",subject:"",sender:""});
 expect(projectMessage({id:"i",receivedDateTime:"2026-01-01",subject:"x",from:{emailAddress:{address:"recruiter@example.com"}}},"inbox").sender).toBe("recruiter@example.com");expect(()=>projectMessage({id:"i"},"inbox")).toThrow();
});
it("maps real headers, stable keys, changed hashes, duplicate quarantine and date/status variants",async()=>{
 const first=await parseRows(sheetData);const reordered=await parseRows([sheetHeaders,[],sheetData[1]]);expect(first[0].key).toBe(reordered[0].key);expect(first[0].ambiguous).toBe(false);
 const changed=await parseRows([sheetHeaders,[...sheetData[1].slice(0,5),"Rejection"]]);expect(changed[0].key).toBe(first[0].key);expect(changed[0].hash).not.toBe(first[0].hash);
 const dup=await parseRows([...sheetData,sheetData[1]]);expect(dup.every(row=>row.ambiguous)).toBe(true);
 for(const status of ["Offer","Interview","Screening","Withdrawal","Other"]){const parsed=await parseRows([sheetHeaders,["Co","Role","","","2026-01-01",status]]);expect(parsed[0].record.status).toBeDefined();}
 expect((await parseRows([sheetHeaders,["Co","Role","","","invalid","Applied"]]))[0].ambiguous).toBe(true);
 expect(await parseRows([])).toEqual([]);await expect(parseRows([["Wrong"]])).rejects.toMatchObject({code:"sheet_headers_changed"});await expect(parseRows(Array(10002).fill([]))).rejects.toMatchObject({code:"sheet_row_limit"});
 expect(normalize(" Example-Co! ")).toBe("example co");expect(dateValue("")).toBe("");expect(dateValue("09/01/2026")).toBe("2026-09-01");
 const withId=await parseRows([[...sheetHeaders,"Application ID"],[...sheetData[1],"explicit-id"]]);expect(withId[0].key).toBe(await digest("explicit-id"));
});
it("uses only a read-only scoped Google JWT and configured batchGet",async()=>{
 const {env,close}=fixture();await expect(fetchSheet(env)).rejects.toMatchObject({code:"sheets_setup_required"});
 const {privateKey}=await generateKeyPair("RS256",{extractable:true});env.GOOGLE_SERVICE_ACCOUNT_JSON=JSON.stringify({client_email:"reader@example.iam.gserviceaccount.com",private_key:await exportPKCS8(privateKey)});
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({access_token:"google"})).mockResolvedValueOnce(Response.json({valueRanges:[{values:sheetData}]}));vi.stubGlobal("fetch",fetcher);
 expect(await fetchSheet(env)).toHaveLength(1);const assertion=fetcher.mock.calls[0][1].body.get("assertion");const claims=JSON.parse(atob(assertion.split(".")[1].replaceAll("-","+").replaceAll("_","/")));
 expect(claims.scope).toBe("https://www.googleapis.com/auth/spreadsheets.readonly");expect(fetcher.mock.calls[1][0]).toContain("values:batchGet");
 fetcher.mockResolvedValueOnce(Response.json({access_token:"google"})).mockResolvedValueOnce(Response.json({valueRanges:[]}));await expect(fetchSheet(env)).rejects.toMatchObject({code:"empty_sheet_response"});
 fetcher.mockResolvedValue(Response.json({}));await expect(fetchSheet(env)).rejects.toMatchObject({code:"invalid_google_token"});close();
});
it("validates and idempotently imports bounded classic Outlook bundles",async()=>{
 const {env,db,close}=fixture();const item={immutableId:"a".repeat(64),folder:"inbox",subject:"Application received",sender:"jobs@example.com",excerpt:"Thanks for applying for Engineer at ExampleCo",occurredAt:"2026-09-30T15:00:00Z",conversationId:"conversation",internetMessageId:"<message@example.com>",revision:"2026-09-30T15:01:00Z"};
 const bundle={format:"job-search-intelligence.outlook-com.v1",accountId:"b".repeat(64),exportedAt:"2026-10-01T00:00:00Z",since:"2026-09-30T07:00:00Z",summary:{truncated:false as const},messages:[item]};
 expect(parseLocalOutlookBatch(bundle,env.HISTORICAL_START_DATE).messages[0]).toMatchObject({folder:"inbox",subject:"Application received"});
 expect(await ingestLocalOutlookBatch(env,bundle)).toEqual({imported:1});expect(await ingestLocalOutlookBatch(env,bundle)).toEqual({imported:1});
 expect((await db.prepare("SELECT COUNT(*) AS count FROM message_references").first<{count:number}>())?.count).toBe(1);expect((await db.prepare("SELECT provider,cursor FROM sync_state WHERE provider='outlook_local'").first())).toMatchObject({provider:"outlook_local",cursor:"2026-10-01T00:00:00.000Z"});
 await db.prepare("INSERT INTO connections VALUES('microsoft','graph-account','encrypted','now','now')").run();await expect(ingestLocalOutlookBatch(env,bundle)).rejects.toMatchObject({status:409,code:"graph_is_authoritative"});
 for(const invalid of [{...bundle,format:"bad"},{...bundle,messages:Array(41).fill(item)},{...bundle,messages:[{...item,occurredAt:"2026-09-01"}]},{...bundle,messages:[item,item]},{...bundle,accountId:"bad"}])expect(()=>parseLocalOutlookBatch(invalid,env.HISTORICAL_START_DATE)).toThrow();
 close();
});
it("uses Internet Message-ID to preserve references during the later Graph transition",async()=>{
 expect(normalizeInternetMessageId(" <Message@Example.COM> ")).toBe("<message@example.com>");
 expect(await emailReferenceId("outlook-local:account","local","<Message@Example.COM>")).toBe(await emailReferenceId("graph-account","immutable"," <message@example.com> "));
 const local={subject:"Application received",sender:"jobs@example.com",occurredAt:"2026-09-30T15:00:00Z",conversationId:"conversation"};const graph={...local,subject:" application   RECEIVED ",occurredAt:"2026-09-30T15:00:00.000Z"};
 expect(await emailReferenceId("outlook-local:account","local","",local)).toBe(await emailReferenceId("graph-account","immutable","",graph));
 expect(await emailReferenceId("one","local","")).not.toBe(await emailReferenceId("two","local",""));
});
