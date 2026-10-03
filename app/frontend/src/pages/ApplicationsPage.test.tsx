import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { intelligenceApi } from "../lib/api";
import { makeState } from "../test/fixtures";
import { calls, renderApp, violations } from "../test/render";

vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), intelligenceApi: vi.fn() }));

const lastList = () => new URLSearchParams((calls(/^\/applications\?/).at(-1)![0] as string).split("?")[1]);
const url = () => new URL(screen.getByTestId("location").textContent!, "http://app.test");
const ready = () => screen.findByRole("button", { name: "View ExampleCo Engineer" });
const drawer = (name = "ExampleCo — Engineer") => screen.findByRole("dialog", { name });
const writes = (path: string) => calls(path).filter(([, method]) => method === "PATCH" || method === "POST");

describe("list and URL state", () => {
  it("loads the first page with the default sort and shows the result summary", async () => {
    renderApp("/applications");
    await ready();
    expect(Object.fromEntries(lastList())).toEqual({ sort: "applied_desc", page: "0", pageSize: "25" });
    expect(screen.getByText("63 applications · Sorted by applied date (newest)")).toBeInTheDocument();
    expect(screen.getByText("1–25 of 63")).toBeInTheDocument();
    expect(screen.getByText("AnotherCo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Export CSV" })).toHaveAttribute("href", "/api/job-intelligence/export");
  });
  it("turns every URL parameter into an API filter and an active-filter chip, and clears them together", async () => {
    renderApp("/applications?q=Co&status=offer&source=sheet&reconciliation=matched&from=2026-09-01&to=2026-09-30&company=ExampleCo&role=Engineer&sort=company&page=1&pageSize=50");
    await ready();
    expect(Object.fromEntries(lastList())).toEqual({ q: "Co", status: "offer", source: "sheet", reconciliation: "matched", from: "2026-09-01", to: "2026-09-30", company: "ExampleCo", role: "Engineer", sort: "company", page: "1", pageSize: "50" });
    const chips = within(screen.getByRole("group", { name: "Active filters" }));
    expect(chips.getByRole("button", { name: "Remove filter: Status: Offer" })).toBeInTheDocument();
    expect(chips.getByRole("button", { name: "Remove filter: Company: ExampleCo" })).toBeInTheDocument();
    expect(screen.getByLabelText("Applied from", { selector: "input" })).toHaveValue("2026-09-01");

    await userEvent.click(chips.getByRole("button", { name: "Clear all filters" }));
    await waitFor(() => expect(Object.fromEntries(lastList())).toEqual({ sort: "company", page: "0", pageSize: "50" }));
    expect(url().search).toBe("?sort=company&pageSize=50");
    expect(screen.queryByRole("group", { name: "Active filters" })).not.toBeInTheDocument();
  });
  it("removes a single chip and returns to the first page", async () => {
    renderApp("/applications?status=offer&source=sheet&page=2");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Remove filter: Status: Offer" }));
    expect(url().search).toBe("?source=sheet");
    await waitFor(() => expect(lastList().get("status")).toBeNull());
  });
  it("resets to the first page when a filter, the sort or the page size changes, and steps through pages", async () => {
    renderApp("/applications?page=2");
    await ready();
    expect(lastList().get("page")).toBe("2");
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(url().search).toBe("?page=1");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(url().search).toBe("?page=2");

    await userEvent.selectOptions(screen.getByLabelText("Status", { selector: "select" }), "offer");
    expect(url().searchParams.get("status")).toBe("offer");
    expect(url().searchParams.has("page")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.selectOptions(screen.getByLabelText("Source"), "email");
    expect(url().searchParams.has("page")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.selectOptions(screen.getByLabelText("Rows per page"), "50");
    expect(url().searchParams.get("pageSize")).toBe("50");
    expect(url().searchParams.has("page")).toBe(false);
    await userEvent.selectOptions(screen.getByLabelText("Reconciliation"), "matched");
    expect(url().searchParams.get("reconciliation")).toBe("matched");
    await waitFor(() => expect(Object.fromEntries(lastList())).toMatchObject({ status: "offer", source: "email", reconciliation: "matched", pageSize: "50", page: "0" }));
  });
  it("debounces search into the URL without adding history entries and resets the page", async () => {
    renderApp("/applications?page=1");
    await ready();
    await userEvent.type(screen.getByLabelText("Search company or role"), "Eng");
    expect(url().searchParams.has("q")).toBe(false);
    await waitFor(() => expect(url().searchParams.get("q")).toBe("Eng"));
    expect(url().searchParams.has("page")).toBe(false);
    await waitFor(() => expect(lastList().get("q")).toBe("Eng"));
  });
  it("sorts from the control and from column headers, and drops the default from the URL", async () => {
    renderApp("/applications");
    await ready();
    await userEvent.selectOptions(screen.getByLabelText("Sort by"), "company");
    expect(url().searchParams.get("sort")).toBe("company");
    expect(screen.getByText(/Sorted by company \(A to Z\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Status" }));
    expect(url().searchParams.get("sort")).toBe("status");
    await userEvent.click(screen.getByRole("button", { name: "Applied" }));
    expect(url().searchParams.has("sort")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Applied" }));
    expect(url().searchParams.get("sort")).toBe("applied_asc");
    expect(screen.getByRole("columnheader", { name: "Applied" })).toHaveAttribute("aria-sort", "ascending");
    await userEvent.click(screen.getByRole("button", { name: "Updated" }));
    expect(url().searchParams.get("sort")).toBe("updated");
    await userEvent.selectOptions(screen.getByLabelText("Sort by"), "applied_desc");
    expect(url().searchParams.has("sort")).toBe(false);
  });
  it("offers date presets and a custom range", async () => {
    renderApp("/applications");
    await ready();
    await userEvent.selectOptions(screen.getByLabelText("Applied date"), "30");
    expect(url().searchParams.get("from")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByLabelText("Applied date")).toHaveValue("30");
    await userEvent.selectOptions(screen.getByLabelText("Applied date"), "custom");
    fireEvent.change(screen.getByLabelText("Applied through", { selector: "input" }), { target: { value: "2026-09-30" } });
    expect(url().searchParams.get("to")).toBe("2026-09-30");
    await userEvent.selectOptions(screen.getByLabelText("Applied date"), "any");
    expect(url().searchParams.has("from")).toBe(false);
    expect(url().searchParams.has("to")).toBe(false);
  });
});

describe("empty and failed lists", () => {
  const none = (path: string) => path.startsWith("/applications?") ? { applications: [], page: 0, pageSize: 25, total: 0, hasMore: false } : undefined;
  it("distinguishes a filtered-empty list from an empty dataset", async () => {
    renderApp("/applications?q=zzz", makeState(), none);
    expect(await screen.findByText("No applications match these filters")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Applications pages" })).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Clear all filters" })[0]);
    expect(await screen.findByText("No applications yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Sources & privacy" })).toHaveAttribute("href", "/sources");
  });
  it("explains a list failure and offers sign-in", async () => {
    renderApp("/applications", makeState(), (path) => { if (path.startsWith("/applications?")) throw new Error("owner access required"); });
    const alert = await screen.findByText("Applications could not be loaded");
    expect(alert.closest("[role=alert]")).toHaveTextContent("owner access required");
    expect(screen.getByRole("link", { name: "Sign in to the private API" })).toHaveAttribute("href", "/api/job-intelligence/session");
  });
});

describe("application drawer", () => {
  it("opens from a row, adds only the app parameter, and returns focus to that row action when closed", async () => {
    renderApp("/applications?status=offer&page=1");
    const view = await ready();
    await userEvent.click(view);
    expect(url().search).toBe("?status=offer&page=1&app=app1");
    expect(await drawer()).toBeInTheDocument();
    expect(view.closest("tr")).toHaveAttribute("aria-current", "true");
    await userEvent.click(within(await drawer()).getByRole("button", { name: "Close" }));
    expect(url().search).toBe("?status=offer&page=1");
    await waitFor(() => expect(view).toHaveFocus());
  });
  it("opens a deep link on its own record and falls back to the page heading when closed", async () => {
    renderApp("/applications?app=app1");
    const dialog = await drawer();
    expect(calls("/applications/app1")).toHaveLength(1);
    expect(within(dialog).getByText("Evidence subject")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(url().search).toBe("");
    expect(screen.getByRole("heading", { level: 1, name: "Applications" })).toHaveFocus();
  });
  it("labels timeline evidence: Outlook link, unavailable source, observed dates and superseded events", async () => {
    const state = makeState();
    state.detail.events.push({ id: "event3", type: "rejection", occurred_at: "2026-10-02", source: "sheet", web_link: null, available: 1, subject: null, date_known: 0, superseded: 1 });
    renderApp("/applications?app=app1", state);
    const dialog = within(await drawer());
    const link = await dialog.findByRole("link", { name: /Open Outlook evidence/ });
    expect(link).toHaveAttribute("href", "https://outlook.live.com/id/1");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    expect(dialog.getByText("Source no longer in a tracked folder")).toBeInTheDocument();
    expect(dialog.getByText("(observed; event date unknown)")).toBeInTheDocument();
    expect(dialog.getByText("Superseded by a later source classification or owner decision")).toBeInTheDocument();
    expect(dialog.getByText("1 recorded owner decision")).toBeInTheDocument();
    expect(dialog.getByText(/Status · 2026-10-01/)).toBeInTheDocument();
  });
  it("shows a message for an application without evidence and for a timeline that cannot load", async () => {
    const state = makeState();
    state.detail.events = []; state.detail.overrides = [];
    const first = renderApp("/applications?app=app1", state);
    expect(await within(await drawer()).findByText("No evidence has been recorded for this application.")).toBeInTheDocument();
    expect(within(await drawer()).getByText("0 recorded owner decisions")).toBeInTheDocument();
    first.unmount();
    renderApp("/applications?app=app1", makeState(), (path) => { if (path === "/applications/app1") throw new Error("Timeline unavailable"); });
    expect(await within(await screen.findByRole("dialog", { name: "Application details" })).findByRole("alert")).toHaveTextContent("Timeline unavailable");
  });
  it("saves a correction with the same payload as before", async () => {
    renderApp("/applications?app=app1");
    const dialog = within(await drawer());
    await userEvent.click(await dialog.findByRole("tab", { name: "Details" }));
    const company = dialog.getByLabelText("Company");
    await userEvent.clear(company);
    await userEvent.type(company, "RenamedCo");
    await userEvent.selectOptions(dialog.getByLabelText("Status"), "interview_scheduled");
    await userEvent.click(dialog.getByRole("button", { name: "Save application" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/applications/app1", "PATCH", { company: "RenamedCo", role: "Engineer", applied_at: "2026-09-30", status: "interview_scheduled" }));
    await waitFor(() => expect(url().search).toBe(""));
    expect(await screen.findByText("Saved. The dashboard has been refreshed.")).toBeInTheDocument();
  });
  it("keeps the drawer open and explains a failed save", async () => {
    renderApp("/applications?app=app1", makeState(), (_path, method) => { if (method === "PATCH") throw new Error("validation failed"); });
    const dialog = within(await drawer());
    await userEvent.click(await dialog.findByRole("tab", { name: "Details" }));
    await userEvent.click(dialog.getByRole("button", { name: "Save application" }));
    expect(await dialog.findByText("Not saved")).toBeInTheDocument();
    expect(dialog.getByText(/validation failed/)).toBeInTheDocument();
    expect(url().search).toBe("?app=app1");
  });
  it("merges into an application chosen through an independent lookup", async () => {
    renderApp("/applications?app=app1");
    const dialog = within(await drawer());
    await userEvent.click(await dialog.findByRole("tab", { name: "Merge" }));
    const target = dialog.getByLabelText("Merge into");
    await waitFor(() => expect(within(target).getByRole("option", { name: /AnotherCo · Analyst/ })).toBeInTheDocument());
    expect(within(target).queryByRole("option", { name: /ExampleCo/ })).not.toBeInTheDocument();
    await userEvent.type(dialog.getByLabelText("Search applications"), "Another");
    await waitFor(() => expect(calls(/^\/applications\?.*q=Another/).length).toBeGreaterThan(0));
    await userEvent.selectOptions(target, "app2");
    await userEvent.selectOptions(dialog.getByLabelText("Verified status after merge"), "rejection");
    await userEvent.click(dialog.getByRole("button", { name: "Merge evidence" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/applications/app1/merge", "POST", { targetId: "app2", status: "rejection" }));
  });
  it("excludes only after an inline confirmation, with no second dialog", async () => {
    renderApp("/applications?app=app1");
    const dialog = within(await drawer());
    const exclude = await dialog.findByRole("button", { name: "Exclude application" });
    await userEvent.click(exclude);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(dialog.getByText("Exclude this application?")).toBeInTheDocument();
    expect(writes("/applications/app1")).toHaveLength(0);

    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(dialog.queryByText("Exclude this application?")).not.toBeInTheDocument();
    expect(exclude).toHaveFocus();
    expect(writes("/applications/app1")).toHaveLength(0);

    await userEvent.click(exclude);
    await userEvent.click(dialog.getByRole("button", { name: "Confirm exclusion" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/applications/app1", "PATCH", { excluded: true }));
    await waitFor(() => expect(url().search).toBe(""));
  });
  it("has no automated accessibility violations with the drawer open", async () => {
    const { container } = renderApp("/applications?app=app1");
    await within(await drawer()).findByText("Evidence subject");
    expect(await violations(container)).toEqual([]);
  });
});

describe("add application", () => {
  it("posts the reviewed application and closes the form", async () => {
    renderApp("/applications");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Add application" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Add application" }));
    await userEvent.type(dialog.getByLabelText("Company"), "NewCo");
    await userEvent.type(dialog.getByLabelText("Role"), "Designer");
    fireEvent.change(dialog.getByLabelText("Applied date"), { target: { value: "2026-09-29" } });
    await userEvent.click(dialog.getByRole("button", { name: "Save application" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/applications", "POST", { company: "NewCo", role: "Designer", applied_at: "2026-09-29", status: "application_submitted" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add application" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Add application" })).toHaveFocus();
  });
  it("keeps the form open and reports a failure", async () => {
    renderApp("/applications", makeState(), (_path, method) => { if (method === "POST") throw new Error("duplicate application"); });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Add application" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Add application" }));
    await userEvent.type(dialog.getByLabelText("Company"), "NewCo");
    await userEvent.type(dialog.getByLabelText("Role"), "Designer");
    fireEvent.change(dialog.getByLabelText("Applied date"), { target: { value: "2026-09-29" } });
    await userEvent.click(dialog.getByRole("button", { name: "Save application" }));
    expect(await dialog.findByText("Not saved")).toBeInTheDocument();
    expect(dialog.getByText(/duplicate application/)).toBeInTheDocument();
  });
});
