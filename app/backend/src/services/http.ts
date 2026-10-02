import type { ApiErrorResponse } from "@job-search/shared";

export function apiError(status: number, error: string, message: string): Response {
  return Response.json({ error, message } satisfies ApiErrorResponse, { status });
}

export function hardenResponse(response: Response, allowedOrigin: string | null): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.headers.set("Vary", "Origin");
  response.headers.set("X-Request-Id", crypto.randomUUID());
  if (allowedOrigin) {
    response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }
  return response;
}
