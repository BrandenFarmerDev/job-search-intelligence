import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Dashboard } from "@job-search/shared";
import { ErrorAlert } from "../components/ErrorAlert";
import { makeDashboard, makeReviews } from "../test/fixtures";
import { intelligenceApi } from "./api";
import { DashboardProvider, useDashboard, type DashboardContextValue } from "./dashboard-context";

vi.mock("./api", async (importOriginal) => ({ ...await importOriginal<typeof import("./api")>(), intelligenceApi: vi.fn() }));

const api = vi.mocked(intelligenceApi);
function mount() {
  return renderHook(() => useDashboard(), { wrapper: DashboardProvider });
}
function respond(handler: (path: string) => unknown = () => undefined) {
  api.mockReset().mockImplementation((async (path: string) => handler(path) ?? (path === "/dashboard" ? makeDashboard() : path === "/review" ? makeReviews() : { saved: true })) as typeof intelligenceApi);
}
const dashboardCalls = () => api.mock.calls.filter(([path]) => path === "/dashboard").length;

describe("useDashboard", () => {
  it("must be used inside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useDashboard())).toThrow("useDashboard must be used inside DashboardProvider");
  });
});

describe("DashboardProvider loading", () => {
  it("loads the dashboard and review queue together", async () => {
    respond();
    const { result } = mount();
    expect(result.current.loading).toBe(true);
    expect(result.current.dashboard).toBeNull();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.dashboard?.total).toBe(4);
    expect(result.current.reviews).toHaveLength(1);
    expect(result.current.error).toBe("");
  });
  it("reports a failed load, then recovers on refresh and bumps the revision", async () => {
    let failing = true;
    respond((path) => { if (path === "/dashboard" && failing) throw new Error("owner access required"); });
    const { result } = mount();
    await waitFor(() => expect(result.current.error).toBe("owner access required"));
    expect(result.current.dashboard).toBeNull();
    expect(result.current.loading).toBe(false);
    failing = false;
    act(() => result.current.refresh());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.dashboard).not.toBeNull());
    expect(result.current.error).toBe("");
    expect(result.current.revision).toBe(1);
  });
  it("falls back to a generic message for a failure that is not an Error", async () => {
    api.mockReset().mockRejectedValue("boom");
    const { result } = mount();
    await waitFor(() => expect(result.current.error).toBe("Dashboard unavailable"));
  });
  it("aborts the in-flight load and ignores its result after unmount", async () => {
    let finish: (value: Dashboard) => void = () => {};
    let seenSignal: AbortSignal | undefined;
    api.mockReset().mockImplementation((async (path: string, _method?: string, _body?: object, signal?: AbortSignal) => {
      if (path === "/dashboard") { seenSignal = signal; return new Promise<Dashboard>((done) => { finish = done; }); }
      return makeReviews();
    }) as typeof intelligenceApi);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = mount();
    await waitFor(() => expect(seenSignal).toBeDefined());
    unmount();
    expect(seenSignal?.aborted).toBe(true);
    await act(async () => { finish(makeDashboard()); });
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("DashboardProvider actions", () => {
  async function loaded() {
    const view = mount();
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    return view;
  }
  it("runs an action, reports its notice and refreshes", async () => {
    respond();
    const { result } = await loaded();
    const before = dashboardCalls();
    let ok = false;
    await act(async () => { ok = await result.current.runAction("/sync/run", "POST", undefined, "Queued."); });
    expect(ok).toBe(true);
    expect(api).toHaveBeenCalledWith("/sync/run", "POST", undefined);
    expect(result.current.notice).toBe("Queued.");
    expect(result.current.busy).toBe(false);
    await waitFor(() => expect(dashboardCalls()).toBe(before + 1));
  });
  it("uses the default notice and POST method", async () => {
    respond();
    const { result } = await loaded();
    await act(async () => { await result.current.runAction("/reprocess"); });
    expect(api).toHaveBeenCalledWith("/reprocess", "POST", undefined);
    expect(result.current.notice).toBe("Saved. The dashboard has been refreshed.");
  });
  it("reports a failure without refreshing and clears it on the next attempt", async () => {
    respond((path) => { if (path === "/data") throw new Error("not allowed"); });
    const { result } = await loaded();
    const before = dashboardCalls();
    let ok = true;
    await act(async () => { ok = await result.current.runAction("/data", "DELETE", { confirmation: "x" }); });
    expect(ok).toBe(false);
    expect(result.current.error).toBe("not allowed");
    expect(result.current.notice).toBe("");
    expect(dashboardCalls()).toBe(before);
    await act(async () => { await result.current.runAction("/reprocess"); });
    expect(result.current.error).toBe("");
  });
  it("describes a failure that is not an Error generically", async () => {
    respond();
    const { result } = await loaded();
    await act(async () => { await result.current.perform(() => Promise.reject("nope")); });
    expect(result.current.error).toBe("Request failed");
  });
  it("marks itself busy while an action is running", async () => {
    respond();
    const { result } = await loaded();
    let finish: () => void = () => {};
    let running: Promise<boolean> = Promise.resolve(false);
    act(() => { running = result.current.perform(() => new Promise<void>((done) => { finish = done; })); });
    expect(result.current.busy).toBe(true);
    await act(async () => { finish(); await running; });
    expect(result.current.busy).toBe(false);
  });
  it("does not update state when an action settles after unmount", async () => {
    respond();
    const view = await loaded();
    const context: DashboardContextValue = view.result.current;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let finish: (message: string) => void = () => {};
    let failing: (reason: Error) => void = () => {};
    let pending: Promise<boolean>[] = [];
    act(() => { pending = [context.perform(() => new Promise<string>((done) => { finish = done; })), context.perform(() => new Promise<string>((_done, reject) => { failing = reject; }))]; });
    view.unmount();
    const before = dashboardCalls();
    await act(async () => { finish("late"); failing(new Error("late failure")); await Promise.all(pending); });
    expect(errors).not.toHaveBeenCalled();
    expect(dashboardCalls()).toBe(before);
  });
});

describe("ErrorAlert", () => {
  it("always offers the sign-in link next to the message", () => {
    render(<ErrorAlert message="owner access required" title="Not loaded" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not loaded");
    expect(screen.getByRole("alert")).toHaveTextContent("owner access required");
    expect(screen.getByRole("link", { name: "Sign in to the private API" })).toHaveAttribute("href", "/api/job-intelligence/session");
  });
});
