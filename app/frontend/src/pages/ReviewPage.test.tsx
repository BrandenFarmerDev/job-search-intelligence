import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { intelligenceApi } from "../lib/api";
import { makeState } from "../test/fixtures";
import { renderApp, violations } from "../test/render";

vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), intelligenceApi: vi.fn() }));

const resolve = async (name = "Recruiter update") => {
  await userEvent.click(await screen.findByRole("button", { name: `Resolve ${name}` }));
  return within(screen.getByRole("form", { name: `Decision for ${name}` }));
};

describe("review queue", () => {
  it("describes each uncertain record and whether its source still exists", async () => {
    const state = makeState();
    state.reviews.push({ id: "review2", source: "sheet", source_id: "row2", state: "conflict", reason: "Two matches", subject: null, available: 1 });
    renderApp("/review", state);
    const items = within(await within(screen.getByRole("main")).findByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByRole("heading", { level: 3, name: "Recruiter update" })).toBeInTheDocument();
    expect(within(items[0]).getByText("Ambiguous")).toBeInTheDocument();
    expect(within(items[0]).getByText("Needs review")).toBeInTheDocument();
    expect(within(items[0]).getByText("Source no longer available in the tracked folder or sheet range.")).toBeInTheDocument();
    expect(within(items[1]).getByRole("heading", { level: 3, name: "Tracker row" })).toBeInTheDocument();
    expect(within(items[1]).queryByText(/no longer available/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing the first 100/)).not.toBeInTheDocument();
  });
  it("names tracker rows from safe snapshot fields and never shows raw JSON", async () => {
    const state = makeState();
    const sheet = (id: string, snapshot: string | null) => ({ ...state.reviews[0], id, source: "sheet", source_id: id, subject: null, snapshot });
    state.reviews = [
      sheet("a", JSON.stringify({ Company: "Acme", "Job Title": "Engineer" })), sheet("b", JSON.stringify({ company: "Globex" })),
      sheet("c", JSON.stringify({ company: 7, role: ["x"] })), sheet("d", "not json"), sheet("e", JSON.stringify(["Acme", "Engineer"])), sheet("f", "null"),
    ];
    renderApp("/review", state);
    const items = within(await within(screen.getByRole("main")).findByRole("list")).getAllByRole("listitem");
    const titles = items.map((item) => within(item).getByRole("heading", { level: 3 }).textContent);
    expect(titles).toEqual(["Tracker row: Acme · Engineer", "Tracker row: Globex", "Tracker row", "Tracker row", "Tracker row", "Tracker row"]);
    expect(screen.queryByText(/[{[]/)).not.toBeInTheDocument();
  });
  it("saves a decision with the chosen application and verified event", async () => {
    const state = makeState();
    renderApp("/review", state);
    const form = await resolve();
    await userEvent.click(form.getByRole("button", { name: "Save decision" }));
    expect(intelligenceApi).not.toHaveBeenCalledWith("/review/decision", expect.anything(), expect.anything());
    await userEvent.selectOptions(form.getByLabelText("Canonical application"), "app1");
    await userEvent.selectOptions(form.getByLabelText("Verified event"), "screening");
    await userEvent.click(form.getByRole("button", { name: "Save decision" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/review/decision", "POST", { source: "email", sourceId: "source1", applicationId: "app1", type: "screening" }));
  });
  it("returns focus to the heading once a decision removes the record", async () => {
    const state = makeState();
    renderApp("/review", state, (path, method) => {
      if (path === "/review/decision" && method === "POST") state.reviews = [];
    });
    const form = await resolve();
    await userEvent.selectOptions(form.getByLabelText("Canonical application"), "app2");
    await userEvent.selectOptions(form.getByLabelText("Verified event"), "rejection");
    await userEvent.click(form.getByRole("button", { name: "Save decision" }));
    expect(await screen.findByText("No outstanding source records.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Review" })).toHaveFocus();
  });
  it("excludes a source without choosing an application", async () => {
    renderApp("/review");
    const form = await resolve();
    await userEvent.click(form.getByRole("button", { name: "Exclude source" }));
    await waitFor(() => expect(intelligenceApi).toHaveBeenCalledWith("/review/decision", "POST", { source: "email", sourceId: "source1", exclude: true }));
  });
  it("keeps the form open and shows the error when a decision fails", async () => {
    renderApp("/review", makeState(), (_path, method) => { if (method === "POST") throw new Error("decision rejected"); });
    const form = await resolve();
    await userEvent.click(form.getByRole("button", { name: "Exclude source" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("decision rejected");
    expect(screen.getByRole("form", { name: "Decision for Recruiter update" })).toBeInTheDocument();
  });
  it("toggles the decision form and exposes its state", async () => {
    renderApp("/review");
    const button = await screen.findByRole("button", { name: "Resolve Recruiter update" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(button);
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
  it("tells the owner when the queue is capped at 100", async () => {
    const state = makeState();
    state.reviews = Array.from({ length: 100 }, (_, index) => ({ ...state.reviews[0], id: `review${index}`, source_id: `source${index}` }));
    renderApp("/review", state);
    expect(await screen.findByText("Showing the first 100 records. Resolve some to see the rest.")).toBeInTheDocument();
  });
  it("shows an empty state when nothing is waiting", async () => {
    const empty = makeState();
    empty.reviews = [];
    renderApp("/review", empty);
    expect(await screen.findByText("No outstanding source records.")).toBeInTheDocument();
  });
  it("has no automated accessibility violations with a decision form open", async () => {
    const { container } = renderApp("/review");
    await resolve();
    expect(await violations(container)).toEqual([]);
  });
});
