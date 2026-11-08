import { apiError } from "./http";

const UNKNOWN_CLIENT = "unknown-client";
const DEADLINE_MS = 1000;

function canonicalClientIp(value: string | null): string {
  if (!value || value.length > 45) return UNKNOWN_CLIENT;
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
    return value.split(".").every((octet) => Number(octet) <= 255) ? value : UNKNOWN_CLIENT;
  }
  if (!value.includes(":") || !/^[a-fA-F0-9:.]+$/.test(value)) return UNKNOWN_CLIENT;
  try { return new URL(`http://[${value}]/`).hostname; }
  catch { return UNKNOWN_CLIENT; }
}

/** One bounded admission decision; no business dispatch may run after a timeout. */
export async function protectRequest(request: Request, limiter: RateLimit | undefined): Promise<Response | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reason = "unavailable";
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalClientIp(request.headers.get("CF-Connecting-IP"))));
    const key = `api:v1:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const outcome: unknown = await Promise.race([
      Promise.resolve().then(() => limiter?.limit({ key })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("deadline")), DEADLINE_MS); }),
    ]);
    if (outcome && typeof outcome === "object" && "success" in outcome) {
      if (outcome.success === true) return null;
      if (outcome.success === false) reason = "denied";
    }
  } catch { /* Binding diagnostics may contain private data; emit only a fixed outcome. */ }
  finally { clearTimeout(timer); }
  const status = reason === "denied" ? 429 : 503;
  console.warn(JSON.stringify({ event: "api_admission", status, reason }));
  const response = apiError(status, status === 429 ? "rate_limited" : "rate_limit_unavailable", "Please wait 60 seconds before trying again.");
  response.headers.set("Retry-After", "60");
  return response;
}
