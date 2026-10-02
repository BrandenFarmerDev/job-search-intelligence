import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { App } from "./App";

function renderApp(path = "/about") { return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>); }
const health = { status: "ok", service: "job-search-intelligence-api", timestamp: "2026-10-01T00:00:00Z" };

describe("workspace information", () => {
  it("presents workspace capabilities and a working API connection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(health)));
    const { container } = renderApp();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("reviewable job-search timeline");
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByText("Private · owner access")).toBeInTheDocument();
    expect(await screen.findByText("API connected")).toBeInTheDocument();
    // jsdom has no canvas/color rendering; contrast is checked on the real browser build.
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });
  it("reports a missing Worker without breaking the page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    renderApp();
    expect(screen.getByRole("status")).toHaveTextContent("Checking API");
    expect(await screen.findByText(/API unavailable/)).toBeInTheDocument();
  });
  it("aborts a pending health check when the page unmounts", async () => {
    let rejectRequest: (error: unknown) => void = () => {};
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise((_, reject) => { rejectRequest = reject; })));
    const { unmount } = renderApp();
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { rejectRequest(new DOMException("Cancelled", "AbortError")); });
  });
  it("ignores a late successful request after unmount", async () => {
    let resolveRequest: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve; })));
    const { unmount } = renderApp();
    unmount();
    await act(async () => { resolveRequest(Response.json(health)); });
  });
  it("offers a keyboard-operable return from an unknown route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url:string)=>Promise.resolve(url.endsWith("/api/health") ? Response.json(health) : Response.json({error:"authentication_required"},{status:401}))));
    renderApp("/missing");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Page not found");
    await userEvent.click(screen.getByRole("link", { name: "Return home" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Job search intelligence");
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in");
  });
});
