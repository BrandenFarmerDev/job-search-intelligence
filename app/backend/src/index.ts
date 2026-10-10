import { healthRoute } from "./routes/health";
import { apiError, hardenResponse } from "./services/http";
import { authorize, Problem, type Principal } from "./services/security";
import { intelligenceRoute } from "./routes/intelligence";
export { JobSyncWorkflow } from "./workflow";

// The only calls the Access service-token principal may make: upload, queue a sync, read run metadata.
const automationRoutes = new Set(["POST /api/job-intelligence/local-outlook/import", "POST /api/job-intelligence/sync/run", "GET /api/job-intelligence/sync-runs"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const allowedOrigin = origin === env.ALLOWED_ORIGIN ? origin : null;
    const finish = (response: Response) => hardenResponse(response, allowedOrigin);
    if (origin !== null && !allowedOrigin) {
      return finish(apiError(403, "origin_not_allowed", "This origin is not allowed."));
    }
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/job-intelligence")) {
      if (request.method === "OPTIONS" && allowedOrigin) return finish(new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } }));
      let principal: Principal | undefined;
      if (!["GET", "HEAD"].includes(request.method) && !allowedOrigin) {
        principal = await authorize(request, env).catch(() => undefined);
        if (principal?.kind !== "automation") return finish(apiError(403, "origin_required", "An approved browser origin is required."));
      }
      try {
        principal ??= await authorize(request, env);
        if (principal.kind === "automation" && (origin !== null || !automationRoutes.has(`${request.method} ${path}`))) return finish(apiError(403, "automation_route_forbidden", "This credential cannot call this route."));
        return finish(await intelligenceRoute(request, env, principal));
      }
      catch (error) { return finish(apiError(error instanceof Problem ? error.status : 500, error instanceof Problem ? error.code : "request_failed", "The request could not be completed.")); }
    }
    if (path !== "/api/health") return finish(apiError(404, "not_found", "Route not found."));
    if (request.method === "OPTIONS") {
      const response = new Response(null, { status: 204 });
      response.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      return finish(response);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      const response = apiError(405, "method_not_allowed", "Method not allowed.");
      response.headers.set("Allow", "GET, HEAD, OPTIONS");
      return finish(response);
    }
    const response = healthRoute();
    return finish(request.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers }) : response);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (env.SYNC_ENABLED === "true" && (await env.JOB_SEARCH_DB.prepare("SELECT value FROM app_metadata WHERE key='sync_paused'").first<{value:string}>())?.value !== "true") await env.JOB_SYNC.create({ params: { trigger: "scheduled" } });
  },
} satisfies ExportedHandler<Env>;
