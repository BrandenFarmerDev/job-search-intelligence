export * from "./intelligence";
export interface HealthResponse {
  status: "ok";
  service: "job-search-intelligence-api";
  timestamp: string;
}

export interface ApiErrorResponse {
  error: string;
  message: string;
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) return false;
  return "status" in value && value.status === "ok"
    && "service" in value && value.service === "job-search-intelligence-api"
    && "timestamp" in value && typeof value.timestamp === "string"
    && Number.isFinite(Date.parse(value.timestamp));
}
