import { isHealthResponse, type HealthResponse } from "@job-search/shared";

export async function getApiHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const apiBase = import.meta.env.VITE_API_BASE_URL || "";
  const response = await fetch(`${apiBase}/api/health`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    credentials: "include",
  });
  if (!response.ok) throw new Error("The API is unavailable.");
  const body: unknown = await response.json();
  if (!isHealthResponse(body)) throw new Error("The API returned an invalid health response.");
  return body;
}

export async function intelligenceApi<T>(path: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || ""}/api/job-intelligence${path}`, {
    method, credentials: "include", headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Sign in through the owner access page to continue.");
    const detail: unknown = await response.json().catch(() => null);
    const code = detail && typeof detail === "object" && "error" in detail && typeof detail.error === "string" ? detail.error.replaceAll("_", " ") : "Request failed";
    throw new Error(code);
  }
  return await response.json() as T;
}
export function exportUrl(): string { return `${import.meta.env.VITE_API_BASE_URL || ""}/api/job-intelligence/export`; }
