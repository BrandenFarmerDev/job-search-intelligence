import { createRemoteJWKSet, jwtVerify } from "jose";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export class Problem extends Error {
  constructor(public status: number, public code: string, public retryAfter = 30) { super(code); }
}
export type Principal = { kind: "owner" | "automation"; id: string };
export async function authorize(request: Request, env: Env): Promise<Principal> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN || !env.OWNER_EMAIL) throw new Problem(401, "authentication_required");
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN)) throw new Problem(503, "auth_unconfigured");
  let keys = keySets.get(issuer);
  if (!keys) { keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 }); keySets.set(issuer, keys); }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD, algorithms: ["RS256"], requiredClaims: ["exp"] });
    if (payload.email === env.OWNER_EMAIL && typeof payload.sub === "string" && payload.sub) return { kind: "owner", id: payload.sub };
    // Access service tokens carry common_name (the client ID), an empty sub and no email.
    if (env.AUTOMATION_CLIENT_ID && payload.common_name === env.AUTOMATION_CLIENT_ID && payload.sub === "" && !("email" in payload) && payload.type === "app") return { kind: "automation", id: "automation" };
    throw new Error("principal_required");
  } catch { throw new Problem(401, "authentication_required"); }
}
export async function readJson(request: Request, limit = 16384): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") throw new Problem(415, "json_required");
  try {
    const value: unknown = JSON.parse(await boundedText(request, limit));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch (error) { if (error instanceof Problem) throw error; throw new Problem(400, "invalid_body"); }
}
export async function boundedText(message: Request | Response, limit = 1_048_576): Promise<string> {
  const reader = message.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw new Problem(413, "payload_too_large"); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes);
  } finally { await reader.cancel(); }
}
export async function providerJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  // Workers supports manual redirect handling, not redirect:"error". Manual keeps
  // authorization headers from being forwarded while the status check rejects hops.
  const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const header=response.headers.get("Retry-After");
    const seconds=header ? /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header)-Date.now())/1000) : 30;
    throw new Problem(response.status === 410 ? 410 : 502, response.status === 429 ? "provider_rate_limited" : "provider_request_failed", Number.isFinite(seconds) ? Math.max(30,Math.min(900,seconds)) : 30);
  }
  return JSON.parse(await boundedText(response)) as T;
}
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
export function randomToken(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
async function encryptionKey(secret: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(atob(secret), (char) => char.charCodeAt(0));
  if (bytes.length !== 32) throw new Problem(503, "encryption_unconfigured");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(value: string, secret: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) }, await encryptionKey(secret), new TextEncoder().encode(value));
  return JSON.stringify({ iv: btoa(String.fromCharCode(...iv)), value: btoa(String.fromCharCode(...new Uint8Array(cipher))) });
}
export async function decrypt(value: string, secret: string, context: string): Promise<string> {
  const envelope = JSON.parse(value) as { iv: string; value: string };
  const decode = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(envelope.iv), additionalData: new TextEncoder().encode(context) }, await encryptionKey(secret), decode(envelope.value));
  return new TextDecoder().decode(plain);
}
export function text(value: unknown, limit = 500): string { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
export function safeLink(value: string, outlookOnly = false): string {
  try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password) return "";
    if (outlookOnly && !["outlook.live.com", "outlook.office.com", "outlook.office365.com"].includes(url.hostname)) return "";
    return url.href;
  } catch { return ""; }
}
