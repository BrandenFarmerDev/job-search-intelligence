import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { intelligenceApi } from "../lib/api";
import { makeState } from "../test/fixtures";
import { calls, renderApp, violations } from "../test/render";

vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), intelligenceApi: vi.fn() }));

const ready = () => screen.findByRole("heading", { level: 2, name: "Connections" });
const dashboardWith = (change: (state: ReturnType<typeof makeState>) => void) => { const state = makeState(); change(state); return state; };

const gmailStatus = (overrides: Record<string, unknown> = {}) => ({ configured: true, connected: true, accountEmail: "branden.farmer.dev@gmail.com", labels: { ready: true, missing: [] }, status: "connected", lastRecentPollAt: null, lastSweepAt: null, pending: 0, review: 0, coverageWarning: null, ...overrides });
const gmail = () => calls("/connections/gmail");

describe("connections and sync", () => {
  it("shows Gmail-only mailbox status, readonly boundary, label requirements and keeps tracker controls", async () => {
    renderApp("/sources");
    await ready();
    expect(await screen.findByText("Connected account: branden.farmer.dev@gmail.com")).toBeInTheDocument();
    expect(screen.getAllByText("Connected")).toHaveLength(2);
    expect(screen.queryByLabelText(/Import local Outlook/)).not.toBeInTheDocument();
    expect(screen.getByText(/read-only permission covers the mailbox/i)).toBeInTheDocument();
    expect(screen.getByText(/Job search, Application receipts, Recruiter follow ups/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause tracker" })).toBeInTheDocument();
  });
  it("offers connect and reconnect with safe setup state and missing labels", async () => {
    const disconnected = gmailStatus({ connected: false, accountEmail: null, status: "disconnected", labels: { ready: false, missing: ["Job search", "Review"] } });
    renderApp("/sources", makeState(), (path) => path === "/connections/gmail" ? disconnected : undefined);
    expect(await screen.findByRole("button", { name: "Connect Gmail" })).toBeInTheDocument();
    expect(screen.getByText(/Create the parent label/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Gmail sync" })).toBeDisabled();
    expect(gmail()).toHaveLength(1);
  });
  it("reconnects when provider authorization needs renewal", async () => {
    renderApp("/sources", makeState(), (path) => path === "/connections/gmail" ? gmailStatus({ connected: false, accountEmail: null, status: "reconnect_required" }) : undefined);
    expect(await screen.findByRole("button", { name: "Reconnect Gmail" })).toBeInTheDocument();
    expect(screen.getByText(/saved authorization needs owner action/)).toBeInTheDocument();
  });
  it("queues sync and explicit resume as separate actions", async () => {
    renderApp("/sources");
    await userEvent.click(await screen.findByRole("button", { name: "Run Gmail sync" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/gmail/sync/run", "POST", { action: "sync" }));
    await userEvent.click(screen.getByRole("button", { name: "Resume Gmail imports" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/gmail/sync/run", "POST", { action: "resume" }));
  });
  it("pauses a connected tracker and connects a paused one", async () => {
    const paused = renderApp("/sources");
    await userEvent.click(await screen.findByRole("button", { name: "Pause tracker" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/connections/sheets", "DELETE", undefined));
    paused.unmount();
    renderApp("/sources", dashboardWith((state) => { state.dashboard.connections.sheets = false; }));
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect tracker" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/connections/sheets", "POST", undefined));
  });
  it("runs a sync, reprocesses evidence and refreshes the dashboard", async () => {
    renderApp("/sources");
    await userEvent.click(await screen.findByRole("button", { name: "Run Gmail sync" }));
    expect(await screen.findByText("Gmail sync queued.")).toBeInTheDocument();
    expect(intelligenceApi).toHaveBeenCalledWith("/gmail/sync/run", "POST", { action: "sync" });
    await userEvent.click(screen.getByRole("button", { name: "Reprocess retained evidence" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/reprocess", "POST", undefined));
    const before = calls("/dashboard").length;
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls("/dashboard").length).toBeGreaterThan(before));
  });
  it("shows a failed action's message in the shell", async () => {
    renderApp("/sources", makeState(), (path, method) => { if (path === "/gmail/sync/run" && method === "POST") throw new Error("provider unavailable"); });
    await userEvent.click(await screen.findByRole("button", { name: "Run Gmail sync" }));
    expect(await screen.findByText(/provider unavailable/)).toBeInTheDocument();
  });
});

describe("sync history", () => {
  it("warns after three failed runs and lists each run with its duration and error", async () => {
    renderApp("/sources");
    expect(await screen.findByText("The last three syncs failed. Review setup and run history before retrying.")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Sync history" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getAllByText(/12 s/)).toHaveLength(3);
    expect(within(table).getByRole("columnheader", { name: "Duration" })).toHaveAttribute("data-align", "end");
    expect(within(table).getAllByText("Provider request failed")).toHaveLength(3);
    expect(within(table).getAllByText("Manual")).toHaveLength(3);
  });
  it("labels the trigger of automatic runs", async () => {
    renderApp("/sources", dashboardWith((state) => {
      state.dashboard.runs = [{ ...state.dashboard.runs[0], id: "9", trigger: "automation" }, { ...state.dashboard.runs[1], trigger: undefined }];
    }));
    const table = await screen.findByRole("table", { name: "Sync history" });
    expect(within(table).getByText("Automation")).toBeInTheDocument();
    expect(within(table).getAllByText("—")).toHaveLength(1);
  });
  it("does not warn when a recent run succeeded, and handles runs that have not finished", async () => {
    renderApp("/sources", dashboardWith((state) => {
      state.dashboard.runs = [{ ...state.dashboard.runs[0], id: "9", status: "completed", finished_at: null, error_code: null }, ...state.dashboard.runs.slice(1)];
    }));
    const table = await screen.findByRole("table", { name: "Sync history" });
    expect(screen.queryByText(/last three syncs failed/)).not.toBeInTheDocument();
    expect(within(table).getByText("Not finished")).toBeInTheDocument();
    expect(within(table).getAllByText("—")).toHaveLength(2);
  });
  it("says so when there are no runs", async () => {
    renderApp("/sources", dashboardWith((state) => { state.dashboard.runs = []; }));
    expect(await screen.findByText("No sync runs yet.")).toBeInTheDocument();
  });
});

describe("delete all job data", () => {
  const open = async () => {
    await userEvent.click(await screen.findByRole("button", { name: "Delete all job data" }));
    return within(await screen.findByRole("dialog", { name: "Delete all job data" }));
  };
  it("requires the exact phrase and sends the typed confirmation", async () => {
    renderApp("/sources");
    const dialog = await open();
    await userEvent.type(dialog.getByLabelText("Type DELETE ALL JOB DATA"), "delete everything");
    expect(dialog.getByRole("button", { name: "Delete permanently" })).toBeDisabled();
    await userEvent.click(dialog.getByRole("button", { name: "Delete permanently" }));
    expect(calls("/data")).toHaveLength(0);
    await userEvent.clear(dialog.getByLabelText("Type DELETE ALL JOB DATA"));
    await userEvent.type(dialog.getByLabelText("Type DELETE ALL JOB DATA"), "DELETE ALL JOB DATA");
    expect(dialog.getByRole("button", { name: "Delete permanently" })).toBeEnabled();
    await userEvent.click(dialog.getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/data", "DELETE", { confirmation: "DELETE ALL JOB DATA" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText(/All job data was deleted/)).toBeInTheDocument();
  });
  it("keeps the dialog open and says nothing was deleted when the request fails", async () => {
    renderApp("/sources", makeState(), (path) => { if (path === "/data") throw new Error("not allowed"); });
    const dialog = await open();
    await userEvent.type(dialog.getByLabelText("Type DELETE ALL JOB DATA"), "DELETE ALL JOB DATA");
    await userEvent.click(dialog.getByRole("button", { name: "Delete permanently" }));
    expect(await dialog.findByText("Nothing was deleted")).toBeInTheDocument();
    expect(dialog.getByText("not allowed")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Delete all job data" })).toBeInTheDocument();
  });
  it("can be dismissed without deleting anything", async () => {
    renderApp("/sources");
    const dialog = await open();
    await userEvent.type(dialog.getByLabelText("Type DELETE ALL JOB DATA"), "DELETE ALL JOB DATA");
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete all job data" }));
    expect(screen.getByLabelText("Type DELETE ALL JOB DATA")).toHaveValue("");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls("/data")).toHaveLength(0);
  });
  it("has no automated accessibility violations with the dialog open", async () => {
    const { container } = renderApp("/sources");
    await open();
    expect(await violations(container)).toEqual([]);
  });
});
