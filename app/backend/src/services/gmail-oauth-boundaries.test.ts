import { afterEach, describe, expect, it, vi } from "vitest";
import { beginGmail, completeGmail, gmailJson, gmailToken } from "./gmail";
import { fixture } from "../test/fixtures";
import { encrypt, Problem } from "./security";

const scope = "https://www.googleapis.com/auth/gmail.readonly";
const key = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=";
function ready(env: Env) {
  Object.assign(env, { GMAIL_CLIENT_ID: "synthetic-client", GMAIL_CLIENT_SECRET: "synthetic-secret", GMAIL_REDIRECT_URI: "https://api.example.test/api/job-intelligence/connections/gmail/callback", GMAIL_MAILBOX: "synthetic-owner@gmail.com", GMAIL_SYNTHETIC_MAILBOX: "synthetic-owner@gmail.com", ENVIRONMENT_NAME: "preview" });
}
async function callbackRequest(env: Env, owner = "owner-sub") {
  const response = await beginGmail(env, owner);
  const url = new URL((await response.json() as { authorizationUrl: string }).authorizationUrl);
  const state = url.searchParams.get("state")!;
  return new Request(`https://api.example.test/api/job-intelligence/connections/gmail/callback?code=one-time-code&state=${state}`, { headers: { Cookie: response.headers.get("Set-Cookie")!.split(";")[0] } });
}
function providerForCallback(profile = "synthetic-owner@gmail.com", returnedScope = scope) {
  return vi.fn(async (url: RequestInfo | URL) => String(url) === "https://oauth2.googleapis.com/token"
    ? Response.json({ access_token: "transient-access", refresh_token: "private-refresh", scope: returnedScope })
    : Response.json({ emailAddress: profile }));
}
async function connectionFixture() {
  const f = fixture(); ready(f.env);
  const generation = (await f.db.prepare("SELECT value FROM app_metadata WHERE key='gmail_connection_generation'").first<{ value: string }>())!.value;
  const encrypted = await encrypt("private-refresh", key, "gmail:synthetic-owner@gmail.com:preview:connection-1");
  await f.db.prepare("INSERT INTO gmail_connections VALUES('connection-1','synthetic-owner@gmail.com',?,?,?,?,'connected',?)")
    .bind(encrypted, new Date().toISOString(), new Date().toISOString(), generation, scope).run();
  return { ...f, generation };
}

afterEach(() => vi.unstubAllGlobals());

describe("Gmail OAuth state and token boundaries", () => {
  it.each([
    ["different owner", (request: Request) => request, "other-owner", "expired_gmail_oauth_state"],
    ["missing state cookie", (request: Request) => new Request(request.url), "owner-sub", "invalid_gmail_oauth_state"],
    ["changed state cookie", (request: Request) => new Request(request.url, { headers: { Cookie: "job_gmail_oauth=not-the-state" } }), "owner-sub", "invalid_gmail_oauth_state"],
    ["expired state", (request: Request) => request, "owner-sub", "expired_gmail_oauth_state"],
  ])("rejects callback replay or tampering: %s", async (label, transform, owner, code) => {
    const { env, db, close } = fixture(); ready(env);
    const request = await callbackRequest(env);
    if (label === "expired state") await db.prepare("UPDATE gmail_oauth_states SET expires_at=0").run();
    await expect(completeGmail(transform(request), env, owner)).rejects.toMatchObject({ code });
    expect(await db.prepare("SELECT id FROM gmail_connections").first()).toBeNull();
    close();
  });

  it.each(["data epoch after deletion", "connection generation after disconnect"]) ("rejects an OAuth callback whose captured %s changed", async (reason) => {
    const { env, db, close } = fixture(); ready(env);
    const request = await callbackRequest(env);
    const keyName = reason.startsWith("data") ? "job_data_generation" : "gmail_connection_generation";
    await db.prepare("UPDATE app_metadata SET value='changed-generation' WHERE key=?").bind(keyName).run();
    vi.stubGlobal("fetch", providerForCallback());
    await expect(completeGmail(request, env, "owner-sub")).rejects.toMatchObject({ code: "stale_gmail_oauth_state" });
    expect(await db.prepare("SELECT id FROM gmail_connections").first()).toBeNull();
    close();
  });

  it.each([
    ["missing granted scopes", ""],
    ["an extra write scope", `${scope} https://www.googleapis.com/auth/gmail.modify`],
    ["an extra send scope", `${scope} https://www.googleapis.com/auth/gmail.send`],
  ])("fails closed for %s and stores no credential", async (_case, returnedScope) => {
    const { env, db, close } = fixture(); ready(env);
    const request = await callbackRequest(env);
    vi.stubGlobal("fetch", providerForCallback("synthetic-owner@gmail.com", returnedScope));
    await expect(completeGmail(request, env, "owner-sub")).rejects.toMatchObject({ code: "gmail_scope_invalid" });
    expect(await db.prepare("SELECT id FROM gmail_connections").first()).toBeNull();
    close();
  });

  it("does not resume imports or change the source selector as a side effect of OAuth callback", async () => {
    const { env, db, close } = fixture(); ready(env);
    const request = await callbackRequest(env);
    vi.stubGlobal("fetch", providerForCallback());
    const response = await completeGmail(request, env, "owner-sub");
    expect(response.status).toBe(303);
    expect(await db.prepare("SELECT value FROM app_metadata WHERE key='gmail_sync_paused'").first()).toMatchObject({ value: "true" });
    expect(await db.prepare("SELECT value FROM app_metadata WHERE key='mail_source'").first()).toMatchObject({ value: "none" });
    close();
  });

  it("marks a revoked refresh token for reconnection without exposing provider details", async () => {
    const { env, db, close } = await connectionFixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_grant", error_description: "provider-private-refresh-detail" }, { status: 400 })));
    let caught: unknown;
    try { await gmailToken(env); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ status: 401, code: "gmail_reconnect_required" });
    expect(String(caught)).not.toContain("provider-private-refresh-detail");
    expect(await db.prepare("SELECT status FROM gmail_connections WHERE id='connection-1'").first()).toMatchObject({ status: "reconnect_required" });
    close();
  });
});

describe("bounded Gmail provider failures", () => {
  it.each([
    [401, {}, "gmail_access_expired", 401],
    [403, { error: { status: "PERMISSION_DENIED" } }, "gmail_permission_required", 403],
    [403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }, "gmail_quota_limited", 429],
    [404, { error: { status: "NOT_FOUND" } }, "gmail_message_unavailable", 404],
    [429, { error: { status: "RESOURCE_EXHAUSTED" } }, "gmail_quota_limited", 429],
    [503, { error: { status: "BACKEND_ERROR" } }, "gmail_provider_failed", 503],
  ])("maps provider status %i to safe app error", async (status, payload, code, mappedStatus) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...payload, diagnostic: "raw-provider-secret" }, { status, headers: { "Retry-After": "120" } })));
    let caught: unknown;
    try { await gmailJson("https://gmail.googleapis.com/gmail/v1/users/me/messages/id", "synthetic-token"); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ status: mappedStatus, code });
    expect(String(caught)).not.toContain("raw-provider-secret");
    expect(JSON.stringify(caught)).not.toContain("raw-provider-secret");
    if (code === "gmail_quota_limited") expect((caught as Problem).retryAfter).toBe(120);
  });

  it("rejects non-Gmail URLs before sending the bearer credential", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(gmailJson("https://evil.example.test/collect", "synthetic-token")).rejects.toMatchObject({ code: "gmail_unsafe_url" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed successful responses without returning raw response content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("raw-provider-response-secret", { status: 200 })));
    await expect(gmailJson("https://gmail.googleapis.com/gmail/v1/users/me/profile", "synthetic-token")).rejects.toMatchObject({ code: "gmail_invalid_response" });
  });
});
