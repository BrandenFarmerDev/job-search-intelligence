import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { intelligenceApi } from "../lib/api";
import { makeState } from "../test/fixtures";
import { calls, renderApp, violations } from "../test/render";

vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), intelligenceApi: vi.fn() }));

const message = { immutableId: "a".repeat(64), folder: "inbox", subject: "Application", sender: "jobs@example.com", excerpt: "Thanks", occurredAt: "2026-10-01T00:00:00Z", conversationId: "c", internetMessageId: "m", revision: "r" };
const bundle = (overrides: Record<string, unknown> = {}, count = 41) => ({
  format: "job-search-intelligence.outlook-com.v1", accountId: "b".repeat(64), exportedAt: "2026-10-01T01:00:00Z", since: "2026-09-30T07:00:00Z",
  summary: { truncated: false }, messages: Array(count).fill(message), ...overrides,
});
const exportFile = (content: unknown) => new File([typeof content === "string" ? content : JSON.stringify(content)], "outlook.json", { type: "application/json" });
const upload = async (file: File) => { await userEvent.upload(await screen.findByLabelText("Import local Outlook JSON"), file); };
const imports = () => calls("/local-outlook/import");
const ready = () => screen.findByRole("heading", { level: 2, name: "Connections" });
const dashboardWith = (change: (state: ReturnType<typeof makeState>) => void) => { const state = makeState(); change(state); return state; };

describe("local Outlook import", () => {
  it("uploads in batches of 40, shows progress, then starts classification", async () => {
    let finishFirst: (value: unknown) => void = () => {};
    const first = new Promise((done) => { finishFirst = done; });
    let seen = 0;
    renderApp("/sources", makeState(), (path) => { if (path === "/local-outlook/import" && seen++ === 0) return first; });
    await upload(exportFile(bundle()));
    expect(await screen.findByText("Uploading batch 1 of 2")).toBeInTheDocument();
    finishFirst({ imported: 40 });
    expect(await screen.findByText("Imported 41 local Outlook messages. Classification is running.")).toBeInTheDocument();
    expect(imports().map(([, , body]) => (body as { messages: unknown[] }).messages.length)).toEqual([40, 1]);
    expect(imports()[0][2]).toMatchObject({ format: "job-search-intelligence.outlook-com.v1", accountId: "b".repeat(64) });
    expect(intelligenceApi).toHaveBeenCalledWith("/sync/run", "POST");
    expect(screen.queryByText(/Uploading batch/)).not.toBeInTheDocument();
  });
  it("blocks a truncated export before anything is uploaded", async () => {
    renderApp("/sources");
    await upload(exportFile(bundle({ summary: { truncated: true } })));
    expect(await screen.findByText(/This export reached its message cap\. Export a narrower date range and try again\./)).toBeInTheDocument();
    expect(imports()).toHaveLength(0);
    expect(calls("/sync/run")).toHaveLength(0);
  });
  it.each([
    ["not an object", "[]"],
    ["messages missing", JSON.stringify(bundle({ messages: undefined }))],
    ["too many messages", JSON.stringify(bundle({}, 10_001))],
    ["summary missing", JSON.stringify(bundle({ summary: undefined }))],
    ["summary is an array", JSON.stringify(bundle({ summary: [] }))],
    ["truncated flag absent", JSON.stringify(bundle({ summary: {} }))],
    ["truncated flag not boolean", JSON.stringify(bundle({ summary: { truncated: "no" } }))],
  ])("rejects an invalid export: %s", async (_name, content) => {
    renderApp("/sources");
    await upload(exportFile(content));
    expect(await screen.findByText(/Invalid local Outlook export\./)).toBeInTheDocument();
    expect(imports()).toHaveLength(0);
  });
  it("rejects a file that is not JSON and one larger than 10 MB", async () => {
    renderApp("/sources");
    await upload(exportFile("not json"));
    expect(await screen.findByText(/not valid JSON/i)).toBeInTheDocument();
    const large = exportFile(bundle());
    Object.defineProperty(large, "size", { value: 10_000_001 });
    await upload(large);
    expect(await screen.findByText(/Local Outlook export is larger than 10 MB\./)).toBeInTheDocument();
    expect(imports()).toHaveLength(0);
  });
  it("reports how many batches were saved when a later batch fails", async () => {
    let seen = 0;
    renderApp("/sources", makeState(), (path) => { if (path === "/local-outlook/import" && seen++ === 1) throw new Error("import failed"); });
    await upload(exportFile(bundle()));
    expect(await screen.findByText(/import failed 1 of 2 batches were saved before this failure\./)).toBeInTheDocument();
    expect(calls("/sync/run")).toHaveLength(0);
    expect(screen.queryByText(/Uploading batch/)).not.toBeInTheDocument();
  });
  it("ignores an empty file choice", async () => {
    renderApp("/sources");
    await ready();
    await userEvent.upload(screen.getByLabelText("Import local Outlook JSON"), []);
    expect(imports()).toHaveLength(0);
  });
});

describe("connections and sync", () => {
  it("shows connection status and has no Microsoft Graph controls", async () => {
    renderApp("/sources");
    await ready();
    expect(screen.getByText("Not imported")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Outlook API|Microsoft|Graph/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Sync never sends email or changes your spreadsheet\./)).toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole("button", { name: "Run sync" }));
    expect(await screen.findByText("Sync queued. Refresh to see results.")).toBeInTheDocument();
    expect(intelligenceApi).toHaveBeenCalledWith("/sync/run", "POST", undefined);
    await userEvent.click(screen.getByRole("button", { name: "Reprocess retained evidence" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/reprocess", "POST", undefined));
    const before = calls("/dashboard").length;
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls("/dashboard").length).toBeGreaterThan(before));
  });
  it("shows a failed action's message in the shell", async () => {
    renderApp("/sources", makeState(), (path, method) => { if (path === "/sync/run" && method === "POST") throw new Error("sheets setup required"); });
    await userEvent.click(await screen.findByRole("button", { name: "Run sync" }));
    expect(await screen.findByText(/sheets setup required/)).toBeInTheDocument();
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
  it("labels the trigger of automatic runs and shows the last automatic upload only when there is one", async () => {
    const without = renderApp("/sources");
    await ready();
    expect(screen.queryByText(/Last automatic upload/)).not.toBeInTheDocument();
    without.unmount();
    renderApp("/sources", dashboardWith((state) => {
      state.dashboard.localOutlookLastAutomatedAt = "2026-10-02T08:00:00Z";
      state.dashboard.runs = [{ ...state.dashboard.runs[0], id: "9", trigger: "automation" }, { ...state.dashboard.runs[1], trigger: undefined }];
    }));
    const table = await screen.findByRole("table", { name: "Sync history" });
    expect(within(table).getByText("Automation")).toBeInTheDocument();
    expect(within(table).getAllByText("—")).toHaveLength(1);
    expect(screen.getByText(/Last automatic upload: /)).toBeInTheDocument();
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
