import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { intelligenceApi } from "../lib/api";
import { makeState } from "../test/fixtures";
import { renderApp, violations } from "../test/render";

vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), intelligenceApi: vi.fn() }));

const kpi = (label: string) => within(screen.getByRole("group", { name: "Key figures" })).getByText(label).closest(".qe-kpi") as HTMLElement;
const insights = () => within(screen.getByRole("region", { name: "Insights" }));
const firstColumn = (table: HTMLElement) => within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent);

describe("Overview key figures", () => {
  it("summarizes applications, rates, median response time and the review queue", async () => {
    renderApp("/");
    await screen.findByRole("group", { name: "Key figures" });
    expect(kpi("Applications")).toHaveTextContent("2 in the last 7 days");
    expect(kpi("Applications")).toHaveTextContent("4");
    expect(kpi("Response rate")).toHaveTextContent("50%");
    expect(kpi("Response rate")).toHaveTextContent("2 of 4 applications");
    expect(kpi("Interview rate")).toHaveTextContent("25%");
    expect(kpi("Median days to first response")).toHaveTextContent("3.5days");
    expect(kpi("Applications needing review")).toHaveTextContent("1 source record in the review queue");
    expect(within(kpi("Applications needing review")).getByRole("link", { name: "Open review queue" })).toHaveAttribute("href", "/review");
    expect(screen.getByText(/Applications since Aug 2026/)).toBeInTheDocument();
  });
  it("says the median is unavailable instead of showing a number", async () => {
    const state = makeState();
    state.dashboard.medianFirstResponseDays = null;
    state.dashboard.metrics.review = 0;
    state.reviews = [];
    renderApp("/", state);
    await screen.findByRole("group", { name: "Key figures" });
    expect(kpi("Median days to first response")).toHaveTextContent("Unavailable");
    expect(kpi("Median days to first response")).toHaveTextContent("No dated responses yet");
    expect(within(kpi("Median days to first response")).queryByText("days")).not.toBeInTheDocument();
    expect(kpi("Applications needing review")).toHaveTextContent("Nothing waiting");
  });
});

describe("Overview charts", () => {
  it("shows stage reach, weekly volume and distributions, each with a table alternative", async () => {
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 3, name: "Stage reach" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Applications per week" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Status distribution" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Reconciliation state" })).toBeInTheDocument();

    const status = screen.getByRole("region", { name: "Status distribution" });
    await userEvent.click(within(status).getByRole("button", { name: "Table" }));
    const table = within(status).getByRole("table", { name: "Status distribution: values" });
    expect(within(table).getByText("Application submitted")).toBeInTheDocument();
    expect(within(table).getByText("Rejection")).toBeInTheDocument();
    await userEvent.click(within(status).getByRole("button", { name: "Chart" }));
    expect(within(status).queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("Overview insights", () => {
  it("lists outcomes by source and links each name to its exact application filter", async () => {
    renderApp("/");
    await screen.findByRole("region", { name: "Insights" });
    expect(insights().getByRole("tab", { name: "By source", selected: true })).toBeInTheDocument();
    expect(insights().getByRole("link", { name: "sheet" })).toHaveAttribute("href", "/applications?source=sheet");
    expect(insights().getByRole("link", { name: "email" })).toHaveAttribute("href", "/applications?source=email");
    expect(insights().getByText("2.5")).toBeInTheDocument();
    expect(insights().getByText("—")).toBeInTheDocument();
  });
  it("switches grouping and encodes names that need escaping", async () => {
    const state = makeState();
    state.dashboard.outcomes.company["A&B Co"] = state.dashboard.outcomes.company.AnotherCo;
    renderApp("/", state);
    await screen.findByRole("region", { name: "Insights" });
    await userEvent.click(insights().getByRole("tab", { name: "By company" }));
    expect(insights().getByRole("link", { name: "ExampleCo" })).toHaveAttribute("href", "/applications?company=ExampleCo");
    expect(insights().getByRole("link", { name: "A&B Co" })).toHaveAttribute("href", "/applications?company=A%26B+Co");
    await userEvent.click(insights().getByRole("tab", { name: "By role" }));
    expect(insights().getByRole("link", { name: "Engineer" })).toHaveAttribute("href", "/applications?role=Engineer");
  });
  it("sorts by a column and reverses on a second click, keeping unknown medians last", async () => {
    renderApp("/");
    await screen.findByRole("region", { name: "Insights" });
    const table = insights().getByRole("table", { name: "Outcomes by source" });
    expect(firstColumn(table)).toEqual(["sheet", "email"]);
    await userEvent.click(within(table).getByRole("button", { name: "Applied" }));
    expect(firstColumn(table)).toEqual(["email", "sheet"]);
    await userEvent.click(within(table).getByRole("button", { name: "Median response days" }));
    expect(firstColumn(table)).toEqual(["email", "sheet"]);
    await userEvent.click(within(table).getByRole("button", { name: "Source" }));
    expect(firstColumn(table)).toEqual(["email", "sheet"]);
    await userEvent.click(within(table).getByRole("button", { name: "Source" }));
    expect(firstColumn(table)).toEqual(["sheet", "email"]);
  });
  it("shows an empty message when nothing has been recorded", async () => {
    const state = makeState();
    state.dashboard.outcomes.role = {};
    renderApp("/", state);
    await screen.findByRole("region", { name: "Insights" });
    await userEvent.click(insights().getByRole("tab", { name: "By role" }));
    expect(insights().getByText("No outcomes recorded yet.")).toBeInTheDocument();
  });
});

describe("Overview follow-ups", () => {
  it("links each due follow-up to its evidence", async () => {
    renderApp("/");
    const table = await screen.findByRole("table", { name: "Follow-ups due" });
    expect(within(table).getByText("ExampleCo")).toBeInTheDocument();
    expect(within(table).getByText("2026-09-30")).toBeInTheDocument();
    expect(within(table).getByText("2026-10-07")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: /^Open evidence\s?for ExampleCo Engineer$/ })).toHaveAttribute("href", "/applications?app=app1");
  });
  it("says so when nothing is due", async () => {
    const state = makeState();
    state.dashboard.followUps = [];
    renderApp("/", state);
    expect(await screen.findByText("No follow-ups due.")).toBeInTheDocument();
  });
});

describe("Overview states", () => {
  it("shows a loading state, then guides an empty dataset to Sources & privacy", async () => {
    const state = makeState();
    state.dashboard.total = 0;
    renderApp("/", state);
    expect(screen.getByText(/Loading private dashboard/)).toBeInTheDocument();
    expect(await screen.findByText("No applications yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Sources & privacy" })).toHaveAttribute("href", "/sources");
    expect(screen.queryByRole("group", { name: "Key figures" })).not.toBeInTheDocument();
  });
  it("offers a retry when the dashboard cannot be loaded", async () => {
    let failing = true;
    renderApp("/", makeState(), (path) => { if (path === "/dashboard" && failing) throw new Error("owner access required"); });
    expect(await screen.findByText("The private dashboard is unavailable")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("owner access required");
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("group", { name: "Key figures" })).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(intelligenceApi).mock.calls.filter(([path]) => path === "/dashboard")).toHaveLength(2));
  });
  it("has no automated accessibility violations when insights and charts are shown as tables", async () => {
    const { container } = renderApp("/");
    await screen.findByRole("region", { name: "Insights" });
    for (const toggle of screen.getAllByRole("button", { name: "Table" })) await userEvent.click(toggle);
    expect(await violations(container)).toEqual([]);
  });
});
