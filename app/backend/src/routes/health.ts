import type { HealthResponse } from "@job-search/shared";

export function healthRoute(): Response {
  const body: HealthResponse = {
    status: "ok",
    service: "job-search-intelligence-api",
    timestamp: new Date().toISOString(),
  };
  return Response.json(body);
}
