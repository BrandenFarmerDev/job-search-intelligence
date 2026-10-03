import { afterEach, expect, it, vi } from "vitest";
import { acquireLease, heartbeat, ingestGraphPage, processMessages, retain, syncSheets } from "./sync";
import { graphBody, graphPage, microsoftToken } from "./microsoft";
import { fetchSheet, parseRows } from "./sheets";
import { fixture, sheetData, sheetHeaders } from "../test/fixtures";
import { Problem } from "./security";
import { ingestLocalOutlookBatch } from "./local-outlook";
vi.mock("./microsoft",async(importOriginal)=>({...await importOriginal<typeof import("./microsoft")>(),microsoftToken:vi.fn(),graphPage:vi.fn(),graphBody:vi.fn()}));
vi.mock("./sheets",async(importOriginal)=>({...await importOriginal<typeof import("./sheets")>(),fetchSheet:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
const message={id:"immutable",subject:"Application received",bodyPreview:"Company: ExampleCo; Position: Engineer; Req: req1",receivedDateTime:"2026-09-30T12:00:00Z",sentDateTime:"2026-09-30T12:00:00Z",conversationId:"conversation",webLink:"https://outlook.live.com/id/1"};
const cursor=(folder="inbox")=>`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?$deltatoken=abc`;
function provider(){vi.mocked(microsoftToken).mockResolvedValue({account:"account",token:"token"});}
it("prevents concurrent runs, permits retry by same owner, rejects stale heartbeats",async()=>{
 const {db,close}=fixture();expect(await acquireLease(db,"one")).toBe(true);expect(await acquireLease(db,"two")).toBe(false);expect(await acquireLease(db,"one")).toBe(true);
 await heartbeat(db,"one");await expect(heartbeat(db,"two")).rejects.toMatchObject({code:"sync_lease_lost"});await db.prepare("UPDATE sync_locks SET expires_at=0").run();expect(await acquireLease(db,"two")).toBe(true);close();
});
it("commits immutable messages with cursor, survives duplicate pages and folder moves",async()=>{
 const {env,db,close}=fixture();provider();await acquireLease(db,"run");vi.mocked(graphPage).mockResolvedValue({value:[message],"@odata.deltaLink":cursor()});
 expect(await ingestGraphPage(env,"inbox","run")).toEqual({done:true,count:1});await ingestGraphPage(env,"inbox","run");expect((await db.prepare("SELECT id FROM message_references").all()).results).toHaveLength(1);
 expect(await processMessages(env,"run")).toBe(1);expect(await processMessages(env,"run")).toBe(0);expect((await db.prepare("SELECT id FROM applications").all()).results).toHaveLength(1);
 vi.mocked(graphPage).mockResolvedValue({value:[message],"@odata.deltaLink":cursor("sentitems")});await ingestGraphPage(env,"sentitems","run");
 vi.mocked(graphPage).mockResolvedValue({value:[{id:message.id,"@removed":{reason:"deleted"}}],"@odata.deltaLink":cursor()});await ingestGraphPage(env,"inbox","run");expect((await db.prepare("SELECT available FROM message_references").first())?.available).toBe(1);
 vi.mocked(graphPage).mockResolvedValue({value:[{id:message.id,"@removed":{reason:"deleted"}}],"@odata.deltaLink":cursor("sentitems")});await ingestGraphPage(env,"sentitems","run");expect((await db.prepare("SELECT available FROM message_references").first())?.available).toBe(0);expect((await db.prepare("SELECT id FROM application_events").all()).results).toHaveLength(1);close();
});
it("upgrades a local fallback reference without Internet Message-ID when Graph becomes authoritative",async()=>{
 const {env,db,close}=fixture();const local={format:"job-search-intelligence.outlook-com.v1",accountId:"a".repeat(64),exportedAt:"2026-10-01T00:00:00Z",since:"2026-09-30T07:00:00Z",summary:{truncated:false as const},messages:[{immutableId:"b".repeat(64),folder:"inbox",subject:message.subject,sender:"jobs@example.com",excerpt:message.bodyPreview,occurredAt:message.receivedDateTime,conversationId:message.conversationId,internetMessageId:"",revision:"2026-09-30T12:01:00Z"}]};
 await ingestLocalOutlookBatch(env,local);await db.prepare("INSERT INTO connections VALUES('microsoft','account','encrypted','now','now')").run();provider();await acquireLease(db,"run");vi.mocked(graphPage).mockResolvedValue({value:[{...message,from:{emailAddress:{address:"jobs@example.com"}}}],"@odata.deltaLink":cursor()});
 await ingestGraphPage(env,"inbox","run");expect((await db.prepare("SELECT COUNT(*) AS count FROM message_references").first<{count:number}>())?.count).toBe(1);expect((await db.prepare("SELECT account_id,immutable_id FROM message_references").first())).toMatchObject({account_id:"account",immutable_id:"immutable"});
 await expect(ingestLocalOutlookBatch(env,local)).rejects.toMatchObject({code:"graph_is_authoritative"});close();
});
it("recovers expired cursors by rebaselining scoped membership and retains event evidence",async()=>{
 const {env,db,close}=fixture();provider();await acquireLease(db,"run");vi.mocked(graphPage).mockResolvedValue({value:[message],"@odata.deltaLink":cursor()});await ingestGraphPage(env,"inbox","run");await processMessages(env,"run");
 vi.mocked(graphPage).mockRejectedValueOnce(new Problem(410,"expired")).mockResolvedValueOnce({value:[],"@odata.deltaLink":cursor()});expect((await ingestGraphPage(env,"inbox","run")).done).toBe(true);expect((await db.prepare("SELECT available FROM message_references").first())?.available).toBe(0);
 vi.mocked(graphPage).mockRejectedValueOnce(new Problem(502,"provider_request_failed"));await expect(ingestGraphPage(env,"inbox","run")).rejects.toThrow();close();
});
it("does not advance a checkpoint on invalid or failed pages",async()=>{
 const {env,db,close}=fixture();provider();await acquireLease(db,"run");vi.mocked(graphPage).mockResolvedValue({value:[message]});await expect(ingestGraphPage(env,"inbox","run")).rejects.toMatchObject({code:"missing_graph_checkpoint"});expect(await db.prepare("SELECT cursor FROM sync_state").first()).toBeNull();
 vi.mocked(graphPage).mockResolvedValue({value:[message],"@odata.nextLink":cursor()});expect((await ingestGraphPage(env,"inbox","run")).done).toBe(false);
 vi.mocked(microsoftToken).mockResolvedValue(null);expect(await ingestGraphPage(env,"inbox","run")).toEqual({done:true,count:0});close();
});
it("keeps ordinary replies in known job conversations for review rather than discarding them",async()=>{
 const {env,db,close}=fixture();provider();await acquireLease(db,"run");vi.mocked(graphPage).mockResolvedValue({value:[message],"@odata.deltaLink":cursor()});await ingestGraphPage(env,"inbox","run");await processMessages(env,"run");
 vi.mocked(graphPage).mockResolvedValue({value:[{...message,id:"reply",subject:"Tuesday works",bodyPreview:"See you then"}],"@odata.deltaLink":cursor()});await ingestGraphPage(env,"inbox","run");await processMessages(env,"run");
 expect((await db.prepare("SELECT state FROM reconciliation_matches WHERE source_id<>(SELECT id FROM message_references WHERE immutable_id='immutable')").first())?.state).toBe("needs_review");close();
});
it("processes only changed tracker rows, retains versions and tombstones removals",async()=>{
 const {env,db,close}=fixture();await acquireLease(db,"run");expect(await syncSheets(env,"run")).toEqual({changed:0,unchanged:0,missing:0});env.GOOGLE_SERVICE_ACCOUNT_JSON="configured";
 vi.mocked(fetchSheet).mockResolvedValue(await parseRows(sheetData));expect(await syncSheets(env,"run")).toEqual({changed:1,unchanged:0,missing:0});expect(await syncSheets(env,"run")).toEqual({changed:0,unchanged:1,missing:0});
 vi.mocked(fetchSheet).mockResolvedValue(await parseRows([sheetHeaders,[...sheetData[1].slice(0,5),"Interview"]]));expect((await syncSheets(env,"run")).changed).toBe(1);expect((await db.prepare("SELECT id FROM sheet_versions").all()).results).toHaveLength(2);
 vi.mocked(fetchSheet).mockResolvedValue([]);expect((await syncSheets(env,"run")).missing).toBe(1);expect((await db.prepare("SELECT available FROM sheet_rows").first())?.available).toBe(0);
 await db.prepare("INSERT INTO app_metadata VALUES('sheets_paused','true')").run();expect((await syncSheets(env,"run")).changed).toBe(0);close();
});
it("quarantines duplicate sheet identities and safely retries an unfinished row",async()=>{
 const {env,db,close}=fixture();env.GOOGLE_SERVICE_ACCOUNT_JSON="configured";await acquireLease(db,"run");vi.mocked(fetchSheet).mockResolvedValue(await parseRows([...sheetData,sheetData[1]]));await syncSheets(env,"run");expect((await db.prepare("SELECT state FROM reconciliation_matches").first())?.state).toBe("needs_review");
 await db.prepare("UPDATE sheet_rows SET processed_hash=NULL").run();expect((await syncSheets(env,"run")).changed).toBeGreaterThan(0);close();
});
it("expires excerpts and transient run/auth history without deleting durable evidence",async()=>{
 const {env,db,close}=fixture();provider();await acquireLease(db,"run");vi.mocked(graphPage).mockResolvedValue({value:[{...message,receivedDateTime:"2020-01-01"}],"@odata.deltaLink":cursor()});await ingestGraphPage(env,"inbox","run");
 await db.prepare("INSERT INTO sync_runs(id,trigger,status,started_at,finished_at) VALUES('old','manual','completed','2020','2020')").run();await db.prepare("INSERT INTO oauth_states VALUES('old','owner','verifier',0)").run();await retain(db);
 expect((await db.prepare("SELECT excerpt FROM message_references").first())?.excerpt).toBeNull();expect(await db.prepare("SELECT id FROM sync_runs").first()).toBeNull();expect(await db.prepare("SELECT state_hash FROM oauth_states").first()).toBeNull();close();
});
it("uses a body fallback only for relevant incomplete previews and skips unchanged messages",async()=>{
 const {env,db,close}=fixture();provider();await acquireLease(db,"run");vi.mocked(graphPage).mockResolvedValue({value:[{...message,bodyPreview:"Thank you for applying"}],"@odata.deltaLink":cursor()});
 vi.mocked(graphBody).mockResolvedValue("Company: ExampleCo; Role: Engineer; Req: req1");await ingestGraphPage(env,"inbox","run");await processMessages(env,"run");
 expect((await db.prepare("SELECT company,role FROM applications").first())).toMatchObject({company:"ExampleCo",role:"Engineer"});await processMessages(env,"run");expect(graphBody).toHaveBeenCalledTimes(1);
 vi.mocked(graphPage).mockResolvedValue({value:[{...message,lastModifiedDateTime:"2026-10-01T12:00:00Z",bodyPreview:"Thank you for applying"}],"@odata.deltaLink":cursor()});await ingestGraphPage(env,"inbox","run");await processMessages(env,"run");
 // Known conversation already supplies identity; full body is not fetched again.
 expect(graphBody).toHaveBeenCalledTimes(1);close();
});
it("never requests a Graph token or body while the version-one feature gate is disabled",async()=>{
 const {env,close}=fixture();env.MICROSOFT_GRAPH_ENABLED="false";await ingestLocalOutlookBatch(env,{format:"job-search-intelligence.outlook-com.v1",accountId:"a".repeat(64),exportedAt:"2026-10-01T00:00:00Z",since:"2026-09-30T07:00:00Z",summary:{truncated:false},messages:[{immutableId:"b".repeat(64),folder:"inbox",subject:"Application received",sender:"jobs@example.com",excerpt:"Thank you for applying",occurredAt:"2026-09-30T15:00:00Z",conversationId:"conversation",internetMessageId:"<local@example.com>",revision:"2026-09-30T15:01:00Z"}]});
 await acquireLease(env.JOB_SEARCH_DB,"run");await processMessages(env,"run");expect(microsoftToken).not.toHaveBeenCalled();expect(graphBody).not.toHaveBeenCalled();close();
});
it("does not inherit an arbitrary application identity when one conversation has multiple applications",async()=>{
 const {env,db,close}=fixture();provider();await acquireLease(db,"run");vi.mocked(graphPage).mockResolvedValue({value:[message],"@odata.deltaLink":cursor()});await ingestGraphPage(env,"inbox","run");await processMessages(env,"run");
 await db.prepare("INSERT INTO applications VALUES('other',NULL,'OtherCo','Engineer','other-req',NULL,'2026-09-30','application_submitted','manual','matched',0,'2026-09-30')").run();
 await db.prepare("INSERT INTO message_references(id,account_id,immutable_id,conversation_id,subject,sender,occurred_at,content_hash,processed_hash,updated_at) VALUES('second','account','second','conversation','','','2026-09-30','hash','hash','2026-09-30')").run();
 await db.prepare("INSERT INTO application_events VALUES('other-event','other','application_confirmation','2026-09-30','email','second',1,'{}')").run();
 vi.mocked(graphPage).mockResolvedValue({value:[{...message,id:"reply",subject:"Following up application",bodyPreview:"Any update?"}],"@odata.deltaLink":cursor()});vi.mocked(graphBody).mockResolvedValue("Following up application");
 await ingestGraphPage(env,"inbox","run");await processMessages(env,"run");
 expect((await db.prepare("SELECT state,application_id FROM reconciliation_matches WHERE reason='Ambiguous match'").first())).toMatchObject({state:"needs_review",application_id:null});expect((await db.prepare("SELECT id FROM applications").all()).results).toHaveLength(2);close();
});
