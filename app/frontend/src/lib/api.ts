import { isHealthResponse, type HealthResponse } from "@job-search/shared";

function responseFailure(method = "GET"): Error {
  return new Error(["GET", "HEAD"].includes(method)
    ? "Unable to connect. Check your connection, wait, and try again."
    : "The outcome is unconfirmed. Check the app state before repeating this action.");
}

async function fetchApi(input: string, init: RequestInit): Promise<Response> {
  try { return await fetch(input, init); }
  catch {
    init.signal?.throwIfAborted();
    throw responseFailure(init.method);
  }
}

async function readJson(response: Response, signal: AbortSignal, method: string, errorResponse = false): Promise<unknown> {
  try {
    const detail: unknown = await response.json();
    signal.throwIfAborted();
    return detail;
  } catch (error) {
    signal.throwIfAborted();
    // A complete malformed error response still gets the existing safe status fallback.
    if (errorResponse && error instanceof SyntaxError) return null;
    throw responseFailure(method);
  }
}

async function admissionError(response: Response, signal: AbortSignal, method: string): Promise<void> {
  signal.throwIfAborted();
  if (response.status === 429) throw new Error("Too many requests. Please wait at least 60 seconds before trying again.");
  if (response.status === 503) {
    const detail: unknown = await readJson(response.clone(), signal, method, true);
    if (detail && typeof detail === "object" && "error" in detail && detail.error === "rate_limit_unavailable") {
      throw new Error("Request protection is temporarily unavailable. Please wait 60 seconds before trying again.");
    }
  }
}

export async function getApiHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  const apiBase = import.meta.env.VITE_API_BASE_URL || "";
  const response = await fetchApi(`${apiBase}/api/health`, {
    signal: requestSignal,
    credentials: "include",
  });
  await admissionError(response, requestSignal, "GET");
  if (!response.ok) throw new Error("The API is unavailable.");
  const body = await readJson(response, requestSignal, "GET");
  if (!isHealthResponse(body)) throw new Error("The API returned an invalid health response.");
  return body;
}

export async function intelligenceApi<T>(path: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  const response = await fetchApi(`${import.meta.env.VITE_API_BASE_URL || ""}/api/job-intelligence${path}`, {
    method, credentials: "include", headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: requestSignal,
  });
  await admissionError(response, requestSignal, method);
  if (!response.ok) {
    if (response.status === 401) throw new Error("Sign in through the owner access page to continue.");
    const detail: unknown = await readJson(response, requestSignal, method, true);
    const code = detail && typeof detail === "object" && "error" in detail && typeof detail.error === "string" ? detail.error.replaceAll("_", " ") : "Request failed";
    throw new Error(code);
  }
  return await readJson(response, requestSignal, method) as T;
}
export const errorMessage = (reason: unknown, fallback: string): string => reason instanceof Error ? reason.message : fallback;
export const sessionUrl = (): string => `${import.meta.env.VITE_API_BASE_URL || ""}/api/job-intelligence/session`;
export function exportUrl(): string { return `${import.meta.env.VITE_API_BASE_URL || ""}/api/job-intelligence/export`; }
