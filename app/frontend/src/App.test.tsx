import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { intelligenceApi } from "./lib/api";
import { systemTheme, viewport } from "./test/media";
import { makeState } from "./test/fixtures";
import { history, renderApp, violations } from "./test/render";

vi.mock("./lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("./lib/api")>(), intelligenceApi: vi.fn() }));

const health = { status: "ok", service: "job-search-intelligence-api", timestamp: "2026-10-01T00:00:00Z" };
const nav = () => within(screen.getByRole("navigation", { name: "Primary navigation" }));

describe("routes", () => {
  it.each([
    ["/", "Overview", "Overview"], ["/applications", "Applications", "Applications"], ["/review", "Review", "Review"], ["/sources", "Sources & privacy", "Sources & privacy"],
    ["/about", "A reviewable job-search timeline", "About"],
  ])("renders %s with its page heading and document title", async (path, heading, title) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(health)));
    renderApp(path);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    expect(document.title).toBe(`${title} – Job Search Intelligence`);
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/dashboard", "GET", undefined, expect.any(AbortSignal)));
  });
  it("shows a not-found page with a way back", async () => {
    renderApp("/nowhere");
    expect(document.title).toBe("Page not found – Job Search Intelligence");
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
  it("opens the menu as a modal overlay, keeps focus inside it and closes it from the scrim, Close, Escape or a link", async () => {
    renderApp("/");
    const toggle = screen.getByRole("button", { name: "Menu" });
    const panel = screen.getByRole("navigation", { name: "Primary navigation" });
    const page = () => [document.querySelector(".qe-shell-header"), screen.getByRole("main"), screen.getByRole("contentinfo")];
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).toHaveAttribute("data-open", "false");
    const scrim = () => document.querySelector(".qe-scrim");
    expect(scrim()).not.toBeInTheDocument();
    for (const region of page()) expect(region).not.toHaveAttribute("inert");

    const open = async () => {
      await userEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(panel).toHaveAttribute("data-open", "true");
      expect(nav().getByRole("link", { name: "Overview" })).toHaveFocus();
      for (const region of page()) expect(region).toHaveAttribute("inert");
    };
    const closed = () => {
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveFocus();
      for (const region of page()) expect(region).not.toHaveAttribute("inert");
    };

    await open();
    // The scrim is a mouse-only dismissal, hidden from assistive technology; Close and Escape serve keyboards.
    expect(scrim()).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(scrim()!);
    closed();
    await open();
    await userEvent.click(nav().getByRole("button", { name: "Close" }));
    closed();
    await open();
    await userEvent.keyboard("{Escape}");
    closed();
    await open();
    await userEvent.click(nav().getByRole("link", { name: "Overview" }));
    closed();

    await open();
    await userEvent.click(nav().getByRole("link", { name: /^Review/ }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(await screen.findByRole("heading", { level: 1, name: "Review" })).toHaveFocus();
    for (const region of page()) expect(region).not.toHaveAttribute("inert");
  });
  it("closes the open overlay when browser Back changes the route, so it cannot reopen later", async () => {
    renderApp("/");
    const panel = screen.getByRole("navigation", { name: "Primary navigation" });
    await userEvent.click(nav().getByRole("link", { name: "Applications" }));
    await screen.findByRole("heading", { level: 1, name: "Applications" });
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(panel).toHaveAttribute("data-open", "true");
    act(() => history.back());
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(panel).toHaveAttribute("data-open", "false");
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
  });
  it("focuses the current page's link when the overlay opens", async () => {
    renderApp("/applications");
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(nav().getByRole("link", { name: "Applications" })).toHaveFocus();
  });
  it("closes the overlay when the window widens to the desktop layout and moves focus to the page", async () => {
    renderApp("/");
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByRole("main")).toHaveAttribute("inert");
    // jsdom has no layout, so report the Menu button as hidden the way the desktop CSS does.
    HTMLElement.prototype.checkVisibility = () => false;
    try { act(() => viewport.change(true)); } finally { delete (HTMLElement.prototype as Partial<HTMLElement>).checkVisibility; }
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("main")).toHaveFocus();
  });
  it("collapses to an icon rail that keeps link names, and remembers the choice", async () => {
    renderApp("/");
    const root = document.documentElement;
    expect(root.dataset.sidebar).toBe("expanded");
    expect(nav().getByRole("link", { name: "Overview" })).not.toHaveAttribute("title");

    const panelToggle = screen.getByRole("button", { name: "Navigation panel" });
    expect(panelToggle).toHaveAttribute("aria-expanded", "true");
    expect(panelToggle).toHaveAttribute("title", "Collapse navigation");
    await userEvent.click(panelToggle);
    expect(panelToggle).toHaveAttribute("aria-expanded", "false");
    expect(panelToggle).toHaveAttribute("title", "Expand navigation");
    expect(panelToggle).toHaveAttribute("aria-controls", "primary-navigation");
    expect(root.dataset.sidebar).toBe("collapsed");
    expect(window.localStorage.getItem("qe-sidebar")).toBe("collapsed");
    expect(nav().getByRole("link", { name: "Overview" })).toHaveAttribute("title", "Overview");
    expect(nav().getByRole("link", { name: /^Review 1\s?records waiting$/ })).toBeInTheDocument();

    await userEvent.click(panelToggle);
    expect(root.dataset.sidebar).toBe("expanded");
    expect(panelToggle).toHaveAttribute("aria-expanded", "true");
  });
  it("starts collapsed from a stored preference", () => {
    window.localStorage.setItem("qe-sidebar", "collapsed");
    renderApp("/");
    expect(screen.getByRole("button", { name: "Navigation panel" })).toHaveAttribute("aria-expanded", "false");
    expect(document.documentElement.dataset.sidebar).toBe("collapsed");
  });
});

describe("theme control", () => {
  const choice = (name: string) => within(screen.getByRole("group", { name: "Theme" })).getByRole("button", { name });
  it("applies and stores the chosen theme, and follows the system while set to System", async () => {
    renderApp("/");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(choice("System theme")).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(choice("Dark theme"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("qe-theme")).toBe("dark");
    expect(choice("Dark theme")).toHaveAttribute("aria-pressed", "true");
    expect(choice("System theme")).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(choice("System theme"));
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => systemTheme.change(true));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await userEvent.click(choice("Light theme"));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
  it("starts from a stored preference", () => {
    window.localStorage.setItem("qe-theme", "dark");
    renderApp("/");
    expect(choice("Dark theme")).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("shell state", () => {
  it("shows the last successful sync in the header", async () => {
    renderApp("/");
    expect(await screen.findAllByText(/Last successful sync:/)).toHaveLength(1);
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


