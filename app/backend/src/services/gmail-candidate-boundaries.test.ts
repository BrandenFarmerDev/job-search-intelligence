import { afterEach, describe, expect, it, vi } from "vitest";
import { extractGmailText, gmailBodyCandidate, gmailDiscoverPage, gmailMetadataCandidate, gmailRefreshLabels, gmailStatus, GMAIL_SCOPE } from "./gmail";
import { digest, encrypt } from "./security";
import { fixture } from "../test/fixtures";
import { createExecutionBudget } from "./execution-budget";

const mailbox = "synthetic-owner@gmail.com";
const encryptionKey = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=";
const labelIds = { "Job search": "root", "Application receipts": "receipt", "Recruiter follow ups": "followup", Interviews: "interviews", Offers: "offers", Rejections: "rejections", "Job alerts": "alerts", Review: "review" };
const encode = (value: string) => btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const now = new Date().toISOString();

async function setup() {
  const f = fixture();
  Object.assign(f.env, {
    GMAIL_CLIENT_ID: "synthetic-client", GMAIL_CLIENT_SECRET: "synthetic-secret",
    GMAIL_REDIRECT_URI: "https://api.example.test/callback", GMAIL_MAILBOX: mailbox,
    GMAIL_SYNTHETIC_MAILBOX: mailbox, ENVIRONMENT_NAME: "preview", MAIL_SOURCE: "gmail",
    GMAIL_ENABLED: "true", GMAIL_SYNC_ENABLED: "true", HISTORICAL_START_DATE: "2026-09-30T07:00:00Z",
  });
  const epoch = (await f.db.prepare("SELECT value FROM app_metadata WHERE key='job_data_generation'").first<{ value: string }>())!.value;
  const connectionGeneration = (await f.db.prepare("SELECT value FROM app_metadata WHERE key='gmail_connection_generation'").first<{ value: string }>())!.value;
  await f.db.batch([
    f.db.prepare("UPDATE app_metadata SET value='gmail' WHERE key='mail_source'"),
    f.db.prepare("UPDATE app_metadata SET value='false' WHERE key='gmail_sync_paused'"),
    f.db.prepare("INSERT INTO app_metadata(key,value) VALUES('gmail_label_ids',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(labelIds)),
    f.db.prepare("INSERT INTO sync_locks(name,owner,expires_at) VALUES('daily','candidate-run',?)").bind(Date.now() + 3600000),
  ]);
  const encrypted = await encrypt("private-refresh", encryptionKey, `gmail:${mailbox}:preview:connection-candidates`);
  await f.db.prepare("INSERT INTO gmail_connections VALUES('connection-candidates',?,?,?,?,?,'connected',?)")
    .bind(mailbox, encrypted, now, now, connectionGeneration, GMAIL_SCOPE).run();
  return { ...f, epoch, connectionGeneration };
}

async function addCandidate(f: Awaited<ReturnType<typeof setup>>, id: string, stage: "metadata" | "body" = "metadata", thread = `thread-${id}`) {
  await f.db.prepare("INSERT INTO gmail_candidates(mailbox,gmail_id,thread_id,stage,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .bind(mailbox, id, thread, stage, now, now).run();
  if (stage === "body") await f.db.prepare(`INSERT INTO gmail_message_instances
    (id,mailbox,gmail_id,thread_id,canonical_id,internet_message_id,labels_json,internal_date,original_date,sender,subject,excerpt,content_hash,available,state,review_reason,updated_at)
    VALUES(?,?,?,?,NULL,NULL,?,? ,NULL,'','',NULL,NULL,1,'pending',NULL,?)`)
    .bind(`instance-${id}`, mailbox, id, thread, JSON.stringify(["root"]), now, now).run();
}

function meta(id: string, labels: string[]) {
  return { id, threadId: `thread-${id}`, labelIds: labels, internalDate: String(Date.parse("2026-10-01T12:00:00Z")), payload: { headers: [
    { name: "From", value: "Recruiter <recruiter@example.test>" }, { name: "Subject", value: "A note" },
    { name: "Date", value: "Thu, 01 Oct 2026 12:00:00 +0000" }, { name: "Message-ID", value: `<${id}@example.test>` },
  ] } };
}
function full(id: string, options: { labels?: string[]; parts?: Record<string, unknown>[]; subject?: string; from?: string; date?: string; internetMessageId?: string } = {}) {
  return { id, threadId: `thread-${id}`, labelIds: options.labels || ["root"], internalDate: String(Date.parse("2026-10-01T12:00:00Z")), payload: { mimeType: "multipart/mixed", headers: [
    { name: "From", value: options.from || "Recruiter <recruiter@example.test>" }, { name: "Subject", value: options.subject || "A note" },
    { name: "Date", value: options.date || "Thu, 01 Oct 2026 12:00:00 +0000" }, { name: "Message-ID", value: options.internetMessageId || `<${id}@example.test>` },
  ], parts: options.parts || [{ mimeType: "text/plain", body: { data: encode("Tuesday works for our follow-up") } }] } };
}
function stubProvider(handler: (url: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ephemeral-access" });
    return handler(url);
  }));
}
function apiMeta(id: string, labels: string[]) {
  return (url: string) => url.includes("format=metadata") ? Response.json(meta(id, labels)) : new Response("unexpected", { status: 500 });
}
function apiFull(id: string, response: unknown | Response) {
  return (url: string) => {
    if (url.includes("/attachments/")) return response instanceof Response ? response : Response.json(response);
    if (url.includes("format=full")) return response instanceof Response ? response : Response.json(response);
    return new Response("unexpected", { status: 500 });
  };
}
async function metadata(f: Awaited<ReturnType<typeof setup>>) { return gmailMetadataCandidate(f.env, "candidate-run", f.epoch, f.connectionGeneration); }
async function body(f: Awaited<ReturnType<typeof setup>>) { return gmailBodyCandidate(f.env, "candidate-run", f.epoch, f.connectionGeneration); }
async function discover(f: Awaited<ReturnType<typeof setup>>) { return gmailDiscoverPage(f.env, "candidate-run", f.epoch, f.connectionGeneration); }

afterEach(() => vi.unstubAllGlobals());

describe("Gmail candidate inclusion boundaries", () => {
  it("persists permission 403 as reconnect-required for body reads without retrying the candidate", async () => {
    const f = await setup(); await addCandidate(f, "permission-body", "body");
    stubProvider(() => Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 }));
    await expect(body(f)).rejects.toMatchObject({ code: "gmail_permission_required" });
    expect(await f.db.prepare("SELECT status FROM gmail_connections WHERE id='connection-candidates'").first()).toMatchObject({ status: "reconnect_required" });
    expect(await f.db.prepare("SELECT stage,body_attempts FROM gmail_candidates WHERE gmail_id='permission-body'").first()).toMatchObject({ stage: "body", body_attempts: 0 });
    expect(await f.db.prepare("SELECT mailbox FROM gmail_cooldowns").first()).toBeNull(); f.close();
  });

  it("persists permission 403 from label setup before surfacing the safe error", async () => {
    const f = await setup(); stubProvider(() => Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 }));
    await expect(gmailRefreshLabels(f.env, "candidate-run", f.epoch, f.connectionGeneration)).rejects.toMatchObject({ code: "gmail_permission_required" });
    expect(await f.db.prepare("SELECT status FROM gmail_connections WHERE id='connection-candidates'").first()).toMatchObject({ status: "reconnect_required" });
    expect(await f.db.prepare("SELECT mailbox FROM gmail_cooldowns").first()).toBeNull(); f.close();
  });

  it("persists permission 403 from discovery so later scheduled runs cannot retry", async () => {
    const f = await setup(); stubProvider(() => Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 }));
    await expect(discover(f)).rejects.toMatchObject({ code: "gmail_permission_required" });
    expect(await f.db.prepare("SELECT status FROM gmail_connections WHERE id='connection-candidates'").first()).toMatchObject({ status: "reconnect_required" });
    expect(await f.db.prepare("SELECT mailbox FROM gmail_cooldowns").first()).toBeNull(); f.close();
  });

  it("commits an external plain-text attachment within the ordinary operation budget", async () => {
    const f = await setup(); await addCandidate(f, "external-budget", "body");
    stubProvider((url) => {
      if (url.includes("format=full")) return Response.json(full("external-budget", { parts: [
        { mimeType: "text/html", body: { data: encode("<p>ignored fallback</p>") } },
        { mimeType: "text/plain", body: { attachmentId: "plain-part" }, headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }] },
      ] }));
      if (url.includes("/attachments/plain-part")) return Response.json({ data: encode("Tuesday works for our follow-up"), size: 33 });
      return new Response("unexpected", { status: 500 });
    });
    const { env, budget } = createExecutionBudget(f.env);
    expect(await gmailBodyCandidate(env, "candidate-run", f.epoch, f.connectionGeneration)).toBe(true);
    // Reserve ten ordinary operations for Workflow acquisition, phase bookkeeping,
    // failure recording and continuation handoff in the real invocation.
    expect(budget.snapshot.totalOperations).toBeLessThanOrEqual(20);
    expect(await f.db.prepare("SELECT state FROM gmail_message_instances WHERE gmail_id='external-budget'").first()).toMatchObject({ state: "pending" });
    f.close();
  });

  it("excludes child-labeled mail without the explicit root label", async () => {
    const f = await setup(); await addCandidate(f, "child-only"); stubProvider(apiMeta("child-only", ["receipt"]));
    expect(await metadata(f)).toBe(true);
    expect(await f.db.prepare("SELECT state,review_reason FROM gmail_message_instances WHERE gmail_id='child-only'").first()).toMatchObject({ state: "excluded", review_reason: "root_label_removed" });
    expect(await f.db.prepare("SELECT stage FROM gmail_candidates WHERE gmail_id='child-only'").first()).toMatchObject({ stage: "done" });
    f.close();
  });

  it.each(["TRASH", "DRAFT"]) ("records %s at metadata stage and never requests a body", async (systemLabel) => {
    const f = await setup(); await addCandidate(f, `skip-${systemLabel}`);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ephemeral-access" });
      return apiMeta(`skip-${systemLabel}`, ["root", systemLabel])(url);
    }); vi.stubGlobal("fetch", fetchMock);
    await metadata(f);
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes("format=full"))).toBe(false);
    expect(await f.db.prepare("SELECT stage FROM gmail_candidates WHERE gmail_id=?").bind(`skip-${systemLabel}`).first()).toMatchObject({ stage: "done" });
    f.close();
  });

  it("accepts root-labeled Spam for reviewable ingestion while status retains the Spam/Junk coverage warning", async () => {
    const f = await setup(); await addCandidate(f, "spam-root"); stubProvider(apiMeta("spam-root", ["root", "SPAM"]));
    await metadata(f);
    expect(await f.db.prepare("SELECT state FROM gmail_message_instances WHERE gmail_id='spam-root'").first()).toMatchObject({ state: "pending" });
    expect((await gmailStatus(f.env)).coverageWarning).toMatch(/Spam\/Junk/);
    f.close();
  });

  it("reports checkpoint freshness, queue counts, reconnect state, and live cooldown without leaking provider detail", async () => {
    const f = await setup(); await addCandidate(f, "pending-status", "metadata"); await addCandidate(f, "review-status", "body");
    await f.db.prepare("UPDATE gmail_candidates SET stage='done' WHERE gmail_id='review-status'").run();
    await f.db.prepare("UPDATE gmail_message_instances SET state='review' WHERE gmail_id='review-status'").run();
    await f.db.prepare("INSERT INTO gmail_checkpoints(mailbox,name,completed_at,updated_at) VALUES(?,'recent','recent-time',?)").bind(mailbox, now).run();
    await f.db.prepare("INSERT INTO gmail_checkpoints(mailbox,name,completed_at,updated_at) VALUES(?,'sweep','sweep-time',?)").bind(mailbox, now).run();
    await f.db.prepare("INSERT INTO gmail_cooldowns(mailbox,until_at,reason) VALUES(?,?,?)").bind(mailbox, Date.now() + 60_000, "safe-provider-code").run();
    const status = await gmailStatus(f.env);
    expect(status).toMatchObject({ connected: true, status: "connected", pending: 1, review: 1, lastRecentPollAt: "recent-time", lastSweepAt: "sweep-time", coverageWarning: "Gmail imports are paused while provider access recovers." });
    expect(JSON.stringify(status)).not.toContain("safe-provider-code");
    await f.db.prepare("UPDATE gmail_connections SET status='reconnect_required'").run();
    await f.db.prepare("UPDATE gmail_cooldowns SET until_at=? WHERE mailbox=?").bind(Date.now() - 1, mailbox).run();
    expect(await gmailStatus(f.env)).toMatchObject({ connected: false, status: "reconnect_required", coverageWarning: expect.stringContaining("Spam/Junk") });
    f.close();
  });
});

describe("Gmail discovery boundary cases", () => {
  it("fails closed before provider access when the exact owner-created root label is absent", async () => {
    const f = await setup(); await f.db.prepare("DELETE FROM app_metadata WHERE key='gmail_label_ids'").run();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(discover(f)).rejects.toMatchObject({ code: "gmail_labels_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
    f.close();
  });

  it("rejects an invalid historical lower bound before querying the provider", async () => {
    const f = await setup(); f.env.HISTORICAL_START_DATE = "not-a-valid-utc-date";
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(discover(f)).rejects.toMatchObject({ code: "historical_date_required" });
    expect(fetchMock).not.toHaveBeenCalled();
    f.close();
  });

  it("starts a seven-day recent window after a recently completed weekly sweep", async () => {
    const f = await setup(); const nowMs = Date.now(); const floor = Date.parse("2026-09-30T07:00:00Z");
    await f.db.prepare(`INSERT INTO gmail_checkpoints(mailbox,name,cursor,window_start,window_end,target_end,completed_at,updated_at)
      VALUES(?,'baseline',NULL,?,?,?, ?,?)`).bind(mailbox, nowMs, nowMs, nowMs, now, now).run();
    await f.db.prepare(`INSERT INTO gmail_checkpoints(mailbox,name,cursor,window_start,window_end,target_end,completed_at,updated_at)
      VALUES(?,'sweep',NULL,?,?,?, ?,?)`).bind(mailbox, nowMs, nowMs, nowMs, now, now).run();
    stubProvider((url) => {
      if (!url.includes("/messages?")) return new Response("unexpected", { status: 500 });
      const query = new URL(url); expect(query.searchParams.has("pageToken")).toBe(false);
      expect(Number(query.searchParams.get("q")?.match(/after:(\d+)/)?.[1])).toBeGreaterThanOrEqual(Math.floor(floor / 1000) - 1);
      return Response.json({ messages: [], nextPageToken: "recent-page-2" });
    });
    expect(await discover(f)).toEqual({ done: false, discovered: 0 });
    expect(await f.db.prepare("SELECT name,cursor FROM gmail_checkpoints WHERE mailbox=? AND name='recent'").bind(mailbox).first()).toMatchObject({ name: "recent", cursor: "recent-page-2" });
    f.close();
  });

  it("alternates recent discovery with an unfinished historical sweep", async () => {
    const f = await setup(); const nowMs = Date.now(); const floor = Date.parse("2026-09-30T07:00:00Z");
    const recentAt = new Date(nowMs - 11 * 86400000).toISOString(); const sweepAt = new Date(nowMs - 10 * 86400000).toISOString();
    await f.db.prepare(`INSERT INTO gmail_checkpoints(mailbox,name,cursor,window_start,window_end,target_end,completed_at,updated_at)
      VALUES(?,'baseline',NULL,?,?,?, ?,?)`).bind(mailbox, nowMs, nowMs, nowMs, now, now).run();
    await f.db.prepare(`INSERT INTO gmail_checkpoints(mailbox,name,cursor,window_start,window_end,target_end,completed_at,updated_at)
      VALUES(?,'sweep',NULL,?,?,?,NULL,?)`).bind(mailbox, floor, floor + 86400000, nowMs, sweepAt).run();
    await f.db.prepare(`INSERT INTO gmail_checkpoints(mailbox,name,cursor,window_start,window_end,target_end,completed_at,updated_at)
      VALUES(?,'recent',NULL,?,?,?, ?,?)`).bind(mailbox, nowMs - 7 * 86400000, nowMs, nowMs, recentAt, recentAt).run();
    let call = 0;
    stubProvider((url) => {
      if (!url.includes("/messages?")) return new Response("unexpected", { status: 500 });
      const after = Number(new URL(url).searchParams.get("q")?.match(/after:(\d+)/)?.[1]);
      if (call++ === 0) expect(after).toBeGreaterThan(Math.floor(floor / 1000)); // recent seven-day slice
      else expect(after).toBe(Math.floor(floor / 1000) - 1); // next share returns to the floor sweep
      return Response.json({ messages: [] });
    });
    await discover(f); await discover(f); expect(call).toBe(2); f.close();
  });

  it("restarts an overdue completed weekly sweep from the historical floor", async () => {
    const f = await setup(); const nowMs = Date.now(); const floor = Date.parse("2026-09-30T07:00:00Z"); const oldTarget = nowMs - 10 * 86400000;
    await f.db.prepare(`INSERT INTO gmail_checkpoints(mailbox,name,cursor,window_start,window_end,target_end,completed_at,updated_at)
      VALUES(?,'baseline',NULL,?,?,?, ?,?)`).bind(mailbox, nowMs, nowMs, nowMs, now, now).run();
    await f.db.prepare(`INSERT INTO gmail_checkpoints(mailbox,name,cursor,window_start,window_end,target_end,completed_at,updated_at)
      VALUES(?,'sweep',NULL,?,?,?, ?,?)`).bind(mailbox, oldTarget, oldTarget, oldTarget, new Date(nowMs - 8 * 86400000).toISOString(), now).run();
    stubProvider((url) => {
      if (!url.includes("/messages?")) return new Response("unexpected", { status: 500 });
      const query = new URL(url); expect(query.searchParams.has("pageToken")).toBe(false);
      expect(Number(query.searchParams.get("q")?.match(/after:(\d+)/)?.[1])).toBe(Math.floor(floor / 1000) - 1);
      return Response.json({ messages: [] });
    });
    expect(await discover(f)).toMatchObject({ done: false, discovered: 0 });
    expect(await f.db.prepare("SELECT window_start,target_end,completed_at FROM gmail_checkpoints WHERE name='sweep'").first()).toMatchObject({ window_start: floor + 86400000, completed_at: null });
    f.close();
  });

  it("terminally excludes metadata received before the historical floor before requesting a body", async () => {
    const f = await setup(); await addCandidate(f, "metadata-before-floor");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ephemeral-access" });
      const response = meta("metadata-before-floor", ["root"]); response.internalDate = String(Date.parse("2026-09-29T23:59:59Z")); return Response.json(response);
    }); vi.stubGlobal("fetch", fetchMock);
    await metadata(f);
    expect(await f.db.prepare("SELECT state,review_reason FROM gmail_message_instances WHERE gmail_id='metadata-before-floor'").first()).toMatchObject({ state: "excluded", review_reason: "before_import_floor" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("format=full"))).toBe(false);
    f.close();
  });

  it("restarts the same fixed window after Gmail expires a page token", async () => {
    const f = await setup();
    await f.db.prepare(`INSERT INTO gmail_checkpoints(mailbox,name,cursor,window_start,window_end,target_end,completed_at,updated_at)
      VALUES(?,'baseline','expired-page-token',?,?,?,NULL,?)`).bind(mailbox, Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-02T00:00:00Z"), Date.parse("2026-10-03T00:00:00Z"), now).run();
    stubProvider((url) => url.includes("/messages?") ? Response.json({ error: { errors: [{ reason: "invalidArgument" }] } }, { status: 400 }) : new Response("unexpected", { status: 500 }));
    expect(await discover(f)).toEqual({ done: false, discovered: 0 });
    expect(await f.db.prepare("SELECT cursor,window_start,window_end FROM gmail_checkpoints WHERE name='baseline'").first()).toMatchObject({ cursor: "__restart__", window_start: Date.parse("2026-10-01T00:00:00Z"), window_end: Date.parse("2026-10-02T00:00:00Z") });
    f.close();
  });

  it.each([
    ["oversized page", [{ id: "first", threadId: "first-thread" }, { id: "second", threadId: "second-thread" }]],
    ["missing immutable message id", [{ id: "", threadId: "thread" }]],
    ["missing thread id", [{ id: "message", threadId: "" }]],
  ])("rejects a %s before checkpointing candidates", async (_case, messages) => {
    const f = await setup();
    stubProvider((url) => url.includes("/messages?") ? Response.json({ messages }) : new Response("unexpected", { status: 500 }));
    await expect(discover(f)).rejects.toMatchObject({ code: messages.length > 1 ? "gmail_invalid_list_page" : "gmail_invalid_list_item" });
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM gmail_candidates").first()).toMatchObject({ count: 0 });
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM gmail_checkpoints WHERE name='baseline'").first()).toMatchObject({ count: 0 });
    f.close();
  });

  it("marks an empty terminal baseline window complete and avoids leaving a phantom cursor", async () => {
    const f = await setup();
    const start = Date.parse("2026-10-01T00:00:00Z"); const end = Date.now() - 1000;
    await f.db.prepare(`INSERT INTO gmail_checkpoints(mailbox,name,cursor,window_start,window_end,target_end,completed_at,updated_at)
      VALUES(?,'baseline',NULL,?,?,?,NULL,?)`).bind(mailbox, start, end, end, now).run();
    stubProvider((url) => url.includes("/messages?") ? Response.json({ messages: [] }) : new Response("unexpected", { status: 500 }));
    expect(await discover(f)).toMatchObject({ done: true, discovered: 0 });
    const row = await f.db.prepare("SELECT cursor,completed_at,window_start,window_end FROM gmail_checkpoints WHERE name='baseline'").first<{cursor:string|null;completed_at:string|null;window_start:number;window_end:number}>();
    expect(row?.cursor).toBeNull(); expect(row?.completed_at).toBeTruthy();
    f.close();
  });
});

describe("Gmail body MIME and durable review boundaries", () => {
  it("decodes declared legacy charsets, rejects malformed bytes, and strips HTML script/style text", () => {
    const latin = Uint8Array.from([99, 97, 102, 233]);
    const latinEncoded = btoa(String.fromCharCode(...latin)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const decoded = extractGmailText({ id: "latin", threadId: "thread", payload: { mimeType: "text/plain", body: { data: latinEncoded }, headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }] } });
    expect(decoded.text).toBe("café");
    const html = extractGmailText({ id: "html", threadId: "thread", payload: { mimeType: "multipart/alternative", parts: [
      { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: { data: encode("<p>Visible</p><script>secret()</script><style>hidden</style>") } },
      { mimeType: "text/plain", body: { data: encode("Plain version") } },
    ] } });
    expect(html.text).toBe("Plain version");
    const projected = extractGmailText({ id: "html-only", threadId: "thread", payload: { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: { data: encode("<p>Visible</p><script>secret()</script><style>hidden</style>") } } });
    expect(projected.text).toBe("Visible");
    const invalidBytes = btoa(String.fromCharCode(255)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    expect(() => extractGmailText({ id: "bad-charset", threadId: "thread", payload: { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }], body: { data: invalidBytes } } })).toThrowError("gmail_mime_charset_unsupported");
  });

  it("keeps readable text eligible when a binary PDF attachment is also present", async () => {
    const f = await setup(); await addCandidate(f, "text-pdf", "body");
    stubProvider(apiFull("text-pdf", full("text-pdf", { parts: [{ mimeType: "text/plain", body: { data: encode("Thank you for applying") } }, { mimeType: "application/pdf", filename: "resume.pdf", body: { size: 20 } }] })));
    expect(await body(f)).toBe(true);
    expect(await f.db.prepare("SELECT state,excerpt FROM gmail_message_instances WHERE gmail_id='text-pdf'").first()).toMatchObject({ state: "pending", excerpt: "Thank you for applying" });
    expect(await f.db.prepare("SELECT stage FROM gmail_candidates WHERE gmail_id='text-pdf'").first()).toMatchObject({ stage: "process" });
    f.close();
  });

  it("fetches a bounded external text part and classifies its text as readable evidence", async () => {
    const f = await setup(); await addCandidate(f, "external-text", "body");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ephemeral-access" });
      if (url.includes("/attachments/text-part")) return Response.json({ data: encode("Recruiter asked to schedule an interview"), size: 39 });
      return Response.json(full("external-text", { parts: [{ mimeType: "text/plain", body: { attachmentId: "text-part" } }] }));
    }); vi.stubGlobal("fetch", fetchMock);
    await body(f);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/attachments/text-part"))).toBe(true);
    expect(await f.db.prepare("SELECT excerpt,state FROM gmail_message_instances WHERE gmail_id='external-text'").first()).toMatchObject({ excerpt: "Recruiter asked to schedule an interview", state: "pending" });
    f.close();
  });

  it("rechecks the root and system labels on the full message before persisting an in-flight candidate", async () => {
    const f = await setup(); await addCandidate(f, "label-removed", "body");
    stubProvider(apiFull("label-removed", full("label-removed", { labels: ["INBOX"] })));
    expect(await body(f)).toBe(true);
    expect(await f.db.prepare("SELECT state,available,review_reason,canonical_id FROM gmail_message_instances WHERE gmail_id='label-removed'").first()).toMatchObject({ state: "excluded", available: 0, review_reason: "root_label_removed", canonical_id: null });
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM message_references WHERE immutable_id='label-removed'").first()).toMatchObject({ count: 0 });
    f.close();
  });

  it("refreshes once after an expired access token and retries the same Gmail message", async () => {
    const f = await setup(); await addCandidate(f, "refresh-retry", "body"); let oauthCalls = 0; let messageCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: ++oauthCalls === 1 ? "expired-access" : "refreshed-access" });
      if (url.includes("format=full")) return ++messageCalls === 1 ? Response.json({ error: "expired" }, { status: 401 }) : Response.json(full("refresh-retry"));
      return new Response("unexpected", { status: 500 });
    }); vi.stubGlobal("fetch", fetchMock);
    expect(await body(f)).toBe(true);
    expect(oauthCalls).toBe(2); expect(messageCalls).toBe(2);
    expect(await f.db.prepare("SELECT stage FROM gmail_candidates WHERE gmail_id='refresh-retry'").first()).toMatchObject({ stage: "process" });
    f.close();
  });

  it("converts an over-limit external text attachment into bounded durable Review", async () => {
    const f = await setup(); await addCandidate(f, "oversized-text-part", "body");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ephemeral-access" });
      if (url.includes("/attachments/oversize")) return Response.json({ data: encode("x".repeat(65537)), size: 65537 });
      return Response.json(full("oversized-text-part", { parts: [{ mimeType: "text/plain", body: { attachmentId: "oversize" } }] }));
    }); vi.stubGlobal("fetch", fetchMock);
    expect(await body(f)).toBe(true);
    expect(await f.db.prepare("SELECT state,review_reason,canonical_id FROM gmail_message_instances WHERE gmail_id='oversized-text-part'").first()).toMatchObject({ state: "review", review_reason: "gmail_text_attachment_oversize", canonical_id: expect.any(String) });
    expect(await f.db.prepare("SELECT stage FROM gmail_candidates WHERE gmail_id='oversized-text-part'").first()).toMatchObject({ stage: "done" });
    f.close();
  });

  it.each([
    ["unsupported charset", [{ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=unsupported-charset" }], body: { data: encode("legacy encoded text") } }]],
    ["encrypted content", [{ mimeType: "application/pkcs7-mime", body: { data: encode("opaque encrypted bytes") } }]],
    ["attachment-only content", [{ mimeType: "application/pdf", filename: "resume.pdf", body: { size: 100 } }]],
  ])("retains %s as a review item rather than creating evidence", async (description, parts) => {
    const f = await setup(); const id = description.replaceAll(" ", "-"); await addCandidate(f, id, "body");
    stubProvider(apiFull(id, full(id, { parts })));
    await body(f);
    expect(await f.db.prepare("SELECT state,review_reason,canonical_id FROM gmail_message_instances WHERE gmail_id=?").bind(id).first()).toMatchObject({ state: "review", canonical_id: expect.any(String) });
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM message_references WHERE id IN (SELECT canonical_id FROM gmail_message_instances WHERE gmail_id=?)").bind(id).first()).toMatchObject({ count: 1 });
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM application_events").first()).toMatchObject({ count: 0 });
    f.close();
  });

  it("turns an owner-forced Review message with no job keywords into durable review without inventing an event", async () => {
    const f = await setup(); await addCandidate(f, "owner-review", "body");
    stubProvider(apiFull("owner-review", full("owner-review", { labels: ["root", "review"], subject: "Tuesday works", parts: [{ mimeType: "text/plain", body: { data: encode("Tuesday works") } }] })));
    await body(f);
    expect(await f.db.prepare("SELECT state,review_reason,canonical_id FROM gmail_message_instances WHERE gmail_id='owner-review'").first()).toMatchObject({ state: "review", review_reason: expect.stringContaining("owner_review_label") });
    const match = await f.db.prepare("SELECT state,reason FROM reconciliation_matches WHERE source='email'").first();
    expect(match).toMatchObject({ state: "needs_review", reason: expect.stringContaining("Gmail review") });
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM application_events").first()).toMatchObject({ count: 0 });
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM applications").first()).toMatchObject({ count: 0 });
    f.close();
  });

  it("aliases a compatible legacy Message-ID without changing canonical keys or manual owner decisions", async () => {
    const f = await setup(); await addCandidate(f, "legacy-alias", "body");
    const legacyId = "legacy-canonical-key"; const messageId = "<shared@example.test>"; const content = "Tuesday works for our follow-up";
    await f.db.prepare(`INSERT INTO message_references(id,account_id,immutable_id,conversation_id,internet_message_id,subject,sender,occurred_at,excerpt,content_hash,available,updated_at,processed_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,1,?,NULL)`).bind(legacyId, "legacy-live-account", "old-immutable", "old-thread", messageId, "A note", "Recruiter <recruiter@example.test>", "2026-10-01T12:00:00.000Z", content, await digest("legacy"), now).run();
    await f.db.prepare("INSERT INTO reconciliation_matches(id,source,source_id,application_id,state,reason,manual) VALUES('owner-choice','email',?,NULL,'matched','owner decision',1)").bind(legacyId).run();
    stubProvider(apiFull("legacy-alias", full("legacy-alias", { internetMessageId: messageId, parts: [{ mimeType: "text/plain", body: { data: encode(content) } }] })));
    await body(f);
    expect(await f.db.prepare("SELECT id,account_id,immutable_id FROM message_references WHERE id=?").bind(legacyId).first()).toMatchObject({ id: legacyId, account_id: "legacy-live-account", immutable_id: "old-immutable" });
    expect(await f.db.prepare("SELECT canonical_id,state FROM gmail_message_instances WHERE gmail_id='legacy-alias'").first()).toMatchObject({ canonical_id: legacyId, state: "imported" });
    expect(await f.db.prepare("SELECT state,reason,manual FROM reconciliation_matches WHERE id='owner-choice'").first()).toMatchObject({ state: "matched", reason: "owner decision", manual: 1 });
    expect(await f.db.prepare("SELECT stage,reason FROM gmail_candidates WHERE gmail_id='legacy-alias'").first()).toMatchObject({ stage: "done", reason: "validated_legacy_alias" });
    f.close();
  });

  it("quarantines a Message-ID collision for review without overwriting the original", async () => {
    const f = await setup(); await addCandidate(f, "id-collision", "body");
    await f.db.prepare(`INSERT INTO message_references(id,account_id,immutable_id,conversation_id,internet_message_id,subject,sender,occurred_at,excerpt,content_hash,available,updated_at,processed_hash)
      VALUES('existing','legacy-account','old-id','old-thread','<id-collision@example.test>','Unrelated subject','Different Sender','2026-10-01T12:00:00Z','Old evidence','hash',1,?,NULL)`).bind(now).run();
    stubProvider(apiFull("id-collision", full("id-collision")));
    await body(f);
    expect(await f.db.prepare("SELECT state,reason FROM reconciliation_matches WHERE source='email'").first()).toMatchObject({ state: "needs_review", reason: expect.stringContaining("Gmail review") });
    expect(await f.db.prepare("SELECT subject,excerpt FROM message_references WHERE id='existing'").first()).toMatchObject({ subject: "Unrelated subject", excerpt: "Old evidence" });
    expect(await f.db.prepare("SELECT state,review_reason FROM gmail_message_instances WHERE gmail_id='id-collision'").first()).toMatchObject({ state: "review", review_reason: "internet_message_id_collision" });
    f.close();
  });

  it("marks a provider-deleted 404 unavailable without deleting retained canonical history", async () => {
    const f = await setup(); await addCandidate(f, "provider-404", "body");
    const canonical = "existing-history";
    await f.db.prepare(`INSERT INTO message_references(id,account_id,immutable_id,conversation_id,internet_message_id,subject,sender,occurred_at,excerpt,content_hash,available,updated_at,processed_hash)
      VALUES(?,?,?,?,NULL,'Saved evidence','recruiter','2026-10-01','excerpt','hash',1,?,NULL)`).bind(canonical, "legacy", "legacy-id", "legacy-thread", now).run();
    await f.db.prepare("UPDATE gmail_message_instances SET canonical_id=? WHERE gmail_id='provider-404'").bind(canonical).run();
    stubProvider(() => Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 }));
    expect(await body(f)).toBe(true);
    expect(await f.db.prepare("SELECT state,available FROM gmail_message_instances WHERE gmail_id='provider-404'").first()).toMatchObject({ state: "unavailable", available: 0 });
    expect(await f.db.prepare("SELECT id,available FROM message_references WHERE id=?").bind(canonical).first()).toMatchObject({ id: canonical, available: 1 });
    f.close();
  });

  it("records malformed provider JSON as a bounded retry without persisting raw response text", async () => {
    const f = await setup(); await addCandidate(f, "poison-404", "body"); await addCandidate(f, "next-valid", "body");
    await f.db.prepare("UPDATE gmail_candidates SET created_at='2026-10-01T00:00:00Z' WHERE gmail_id='poison-404'").run();
    await f.db.prepare("UPDATE gmail_candidates SET created_at='2026-10-02T00:00:00Z' WHERE gmail_id='next-valid'").run();
    // The first due item receives a terminal 404 and moves to done; the next call can then select the later item.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ephemeral-access" });
      if (url.includes("/messages/poison-404?format=full")) return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
      if (url.includes("/messages/next-valid?format=full")) return new Response("provider-secret-body", { status: 200 });
      return new Response("unexpected", { status: 500 });
    }); vi.stubGlobal("fetch", fetchMock);
    expect(await body(f)).toBe(true);
    expect(await f.db.prepare("SELECT stage,body_attempts FROM gmail_candidates WHERE gmail_id='poison-404'").first()).toMatchObject({ stage: "done", body_attempts: 1 });
    // Existing candidate selector intentionally sorts by creation time then ID, so ensure the due queue is fair after terminalization.
    await f.db.prepare("UPDATE gmail_candidates SET created_at='2026-10-02T00:00:00Z' WHERE gmail_id='poison-404'").run();
    await expect(body(f)).rejects.toMatchObject({ code: "gmail_invalid_response" });
    expect(await f.db.prepare("SELECT stage,body_attempts,reason FROM gmail_candidates WHERE gmail_id='next-valid'").first()).toMatchObject({ stage: "body", body_attempts: 1, reason: "gmail_invalid_response" });
    expect((await f.db.prepare("SELECT reason FROM gmail_candidates WHERE gmail_id='next-valid'").first<{reason:string}>())?.reason).not.toContain("provider-secret-body");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("next-valid");
    f.close();
  });
});
