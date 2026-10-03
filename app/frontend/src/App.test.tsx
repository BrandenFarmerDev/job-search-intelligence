import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { intelligenceApi } from "./lib/api";
import { systemTheme } from "./test/media";
import { makeState } from "./test/fixtures";
import { renderApp, violations } from "./test/render";

vi.mock("./lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("./lib/api")>(), intelligenceApi: vi.fn() }));

const health = { status: "ok", service: "job-search-intelligence-api", timestamp: "2026-10-01T00:00:00Z" };
const nav = () => within(screen.getByRole("navigation", { name: "Primary navigation" }));

describe("routes", () => {
  it.each([
    ["/", "Overview"], ["/applications", "Applications"], ["/review", "Review"], ["/sources", "Sources & privacy"], ["/about", "A reviewable job-search timeline"],
  ])("renders %s with its page heading", async (path, heading) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(health)));
    renderApp(path);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/dashboard", "GET", undefined, expect.any(AbortSignal)));
  });
  it("shows a not-found page with a way back", async () => {
    renderApp("/nowhere");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Page not found");
    expect(screen.getByRole("link", { name: "Return home" })).toHaveAttribute("href", "/");
    expect(nav().queryByRole("link", { current: "page" })).not.toBeInTheDocument();
  });
  it("reports the API connection on the About page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(health)));
    renderApp("/about");
    expect(await screen.findByText("API connected")).toBeInTheDocument();
    expect(screen.getByText(/Microsoft Graph access is a future option only/)).toBeInTheDocument();
  });
});

describe("navigation", () => {
  it("marks the current page and moves focus to the new heading after a route change, but not on first load", async () => {
    renderApp("/");
    const first = await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(first).not.toHaveFocus();
    expect(nav().getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    expect(nav().getByRole("link", { name: "Applications" })).not.toHaveAttribute("aria-current");

    await userEvent.click(nav().getByRole("link", { name: "Applications" }));
    const next = await screen.findByRole("heading", { level: 1, name: "Applications" });
    expect(next).toHaveFocus();
    expect(screen.getByTestId("location")).toHaveTextContent("/applications");
    expect(nav().getByRole("link", { name: "Applications" })).toHaveAttribute("aria-current", "page");
    expect(nav().getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });
  it("lists a skip link and the waiting review count in the navigation", async () => {
    renderApp("/");
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
    expect(await nav().findByRole("link", { name: /^Review 1\s?records waiting$/ })).toHaveAttribute("href", "/review");
  });
  it("caps the review badge at 100+", async () => {
    const state = makeState();
    state.reviews = Array.from({ length: 100 }, (_, index) => ({ ...state.reviews[0], id: `review${index}` }));
    renderApp("/", state);
    expect(await nav().findByRole("link", { name: /^Review 100\+\s?records waiting$/ })).toBeInTheDocument();
  });
  it("toggles the menu, closes it on navigation or Escape, and returns focus to the toggle", async () => {
    renderApp("/");
    const toggle = screen.getByRole("button", { name: "Menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toHaveAttribute("data-open", "false");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toHaveAttribute("data-open", "true");
    await userEvent.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();

    await userEvent.click(toggle);
    await userEvent.click(nav().getByRole("link", { name: /^Review/ }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

describe("theme control", () => {
  it("applies and stores the chosen theme, and follows the system while set to System", async () => {
    renderApp("/");
    const select = screen.getByLabelText("Theme");
    expect(document.documentElement.dataset.theme).toBe("light");

    await userEvent.selectOptions(select, "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("qe-theme")).toBe("dark");

    await userEvent.selectOptions(select, "system");
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => systemTheme.change(true));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
  it("starts from a stored preference", () => {
    window.localStorage.setItem("qe-theme", "dark");
    renderApp("/");
    expect(screen.getByLabelText("Theme")).toHaveValue("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("shell state", () => {
  it("shows the last successful sync in the header", async () => {
    renderApp("/");
    expect(await screen.findAllByText(/Last successful sync:/)).toHaveLength(2);
  });
  it("offers a sign-in link when the dashboard cannot load", async () => {
    renderApp("/review", makeState(), (path) => { if (path === "/dashboard") throw new Error("Sign in through the owner access page to continue."); });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Sign in through the owner access page to continue.");
    expect(within(alert).getByRole("link", { name: "Sign in to the private API" })).toHaveAttribute("href", "/api/job-intelligence/session");
    expect(screen.getByText("No successful sync yet")).toBeInTheDocument();
  });
  it("has no automated accessibility violations on the shell and overview", async () => {
    const { container } = renderApp("/");
    await screen.findByRole("group", { name: "Key figures" });
    expect(await violations(container)).toEqual([]);
  });
});


