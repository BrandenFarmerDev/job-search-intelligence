import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { BarChart, ChartFrame, ColumnChart, StageReach, groupTopItems } from ".";
import { countOf, formatWeek, truncate } from "./chart-utils";

const scan = async (container: HTMLElement) => (await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations;
const items = Array.from({ length: 11 }, (_, index) => ({ label: `Source ${String.fromCharCode(65 + index)}`, value: 20 - index }));
const weeks = Array.from({ length: 26 }, (_, index) => ({ weekStart: new Date(Date.UTC(2026, 3, 13 + index * 7)).toISOString().slice(0, 10), count: index % 5 === 0 ? 0 : index }));
const bars = (container: HTMLElement) => [...container.querySelectorAll(".qe-bar")];

function stubWidth(width: number) {
  const observers: ((entries: unknown[]) => void)[] = [];
  vi.stubGlobal("ResizeObserver", class { constructor(callback: (entries: unknown[]) => void) { observers.push(callback); } observe() {} disconnect() {} });
  return () => act(() => observers.forEach((callback) => callback([{ contentRect: { width } }])));
}

describe("chart helpers", () => {
  it("formats weeks, counts and truncated labels", () => {
    expect(formatWeek("2026-10-05")).toBe("Oct 5");
    expect(formatWeek("2026-13-05")).toBe("2026-13-05 5");
    expect(countOf(1, "application")).toBe("1 application");
    expect(countOf(2, "application")).toBe("2 applications");
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a very long label", 8)).toBe("a very …");
    expect(truncate("abc", 0)).toBe("a…");
  });
  it("groups categories beyond the limit, but never hides a single leftover", () => {
    expect(groupTopItems(items.slice(0, 9), 8)).toHaveLength(9);
    const grouped = groupTopItems(items, 8);
    expect(grouped).toHaveLength(9);
    expect(grouped[8]).toEqual({ label: "Other (3)", value: 33, merged: 3 });
    expect(groupTopItems([{ label: "b", value: 1 }, { label: "a", value: 1 }], 8).map((item) => item.label)).toEqual(["a", "b"]);
    expect(groupTopItems([{ label: "b", value: 1 }, { label: "a", value: 2 }], 8, false).map((item) => item.label)).toEqual(["b", "a"]);
  });
});

describe("BarChart", () => {
  it("shows the top eight plus Other with direct labels, values and focusable bars", () => {
    const { container } = render(<BarChart title="Applications by source" items={items} unit="application" />);
    expect(screen.getByRole("heading", { level: 3, name: "Applications by source" })).toBeInTheDocument();
    const chart = screen.getByRole("img", { name: "Applications by source" });
    expect(chart).toHaveAccessibleDescription(/Horizontal bar chart of 11 categories; the largest is Source A with 20 applications/);
    expect(bars(container)).toHaveLength(9);
    for (const bar of bars(container)) expect(bar).toHaveAttribute("tabindex", "0");
    expect(within(chart).getByText("Source A")).toBeInTheDocument();
    expect(within(chart).getByText("Other (3)")).toBeInTheDocument();
    expect(container.querySelector("title")).toHaveTextContent("Source A: 20 applications");
    expect(bars(container)[8].querySelector("title")).toHaveTextContent("Other (3 categories): 33 applications");
  });
  it("toggles to a table that lists every category, not just the grouped ones", async () => {
    render(<BarChart title="By source" items={items} />);
    const toggle = screen.getByRole("button", { name: "View as table" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "View as chart" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("table", { name: "By source: values" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(12);
    expect(screen.getByRole("columnheader", { name: "Applications" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View as chart" }));
    expect(screen.getByRole("img")).toBeInTheDocument();
  });
  it("can show each value as a share of a fixed maximum", async () => {
    const { container } = render(<BarChart title="Share" items={[{ label: "Responded", value: 1 }, { label: "Offers", value: 0 }]} max={4} showShare unit="response" categoryHeader="Stage" />);
    expect(screen.getByText("1 · 25%")).toBeInTheDocument();
    expect(container.querySelectorAll(".qe-chart-track")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "View as table" }));
    expect(screen.getByRole("columnheader", { name: "Share of all applications" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Stage" })).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
  });
  it("guards against a zero scale and uses the series colour", () => {
    const { container } = render(<BarChart title="Zero" items={[{ label: "None", value: 0 }]} max={0} showShare series={3} headingLevel={2} />);
    expect(container.querySelector(".qe-series-3")).toHaveAttribute("width", "0");
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
  });
  it("shows an empty state instead of an empty chart", () => {
    render(<BarChart title="Nothing" items={[]} emptyDescription="Import applications first." />);
    expect(screen.getByText("No data yet")).toBeInTheDocument();
    expect(screen.getByText("Import applications first.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View as table" })).not.toBeInTheDocument();
  });
  it("redraws at its measured width and truncates long labels to fit", () => {
    const resize = stubWidth(320);
    const { container } = render(<BarChart title="Narrow" description="Direct labels" items={[{ label: "An extraordinarily long company name", value: 3 }]} />);
    resize();
    expect(container.querySelector("svg")).toHaveAttribute("width", "320");
    expect(screen.getByText(/…$/)).toBeInTheDocument();
    expect(screen.getByText("Direct labels")).toBeInTheDocument();
  });
});

describe("ColumnChart", () => {
  it("draws a focusable column per week with accessible text for each", () => {
    const { container } = render(<ColumnChart title="Weekly applications" weeks={weeks} />);
    expect(bars(container)).toHaveLength(26);
    expect(bars(container)[1].querySelector("title")).toHaveTextContent("Week of Apr 20: 1 application");
    expect(bars(container)[2].querySelector("title")).toHaveTextContent("Week of Apr 27: 2 applications");
    expect(screen.getByRole("img", { name: "Weekly applications" })).toHaveAccessibleDescription(/Column chart of .* over 26 weeks/);
  });
  it("thins axis labels and drops value labels when the chart is narrow", () => {
    const wide = render(<ColumnChart title="Wide" weeks={weeks} />);
    const wideLabels = wide.container.querySelectorAll(".qe-chart-axis").length;
    const wideValues = wide.container.querySelectorAll(".qe-chart-value").length;
    wide.unmount();
    const resize = stubWidth(240);
    const narrow = render(<ColumnChart title="Narrow" weeks={weeks} />);
    resize();
    expect(narrow.container.querySelectorAll(".qe-chart-axis").length).toBeLessThan(wideLabels);
    expect(wideValues).toBeGreaterThan(0);
    expect(narrow.container.querySelectorAll(".qe-chart-value")).toHaveLength(0);
  });
  it("offers every week in the table view and an empty state when nothing was applied", async () => {
    const { unmount } = render(<ColumnChart title="Weekly" weeks={weeks} />);
    await userEvent.click(screen.getByRole("button", { name: "View as table" }));
    expect(screen.getAllByRole("row")).toHaveLength(27);
    expect(screen.getByRole("columnheader", { name: "Week starting" })).toBeInTheDocument();
    unmount();
    render(<ColumnChart title="Weekly" weeks={weeks.map((week) => ({ ...week, count: 0 }))} emptyDescription="No applications in the last 26 weeks." />);
    expect(screen.getByText("No applications in the last 26 weeks.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("copes with no weeks at all", () => {
    render(<ColumnChart title="None" weeks={[]} />);
    expect(screen.getByText("No data yet")).toBeInTheDocument();
  });
});

describe("StageReach", () => {
  it("measures every stage against all applications and says it is not a funnel", async () => {
    render(<StageReach total={40} responses={10} screenings={4} interviews={12} offers={1} />);
    expect(screen.getByText(/Stages are counted independently/)).toBeInTheDocument();
    expect(screen.getByText("Applied")).toBeInTheDocument();
    expect(screen.getByText("40 · 100%")).toBeInTheDocument();
    expect(screen.getByText("12 · 30%")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View as table" }));
    expect(screen.getAllByRole("row").slice(1).map((row) => row.textContent)).toEqual(["Applied40100%", "Responded1025%", "Screening410%", "Interview1230%", "Offer13%"]);
  });
  it("shows an empty state before any application exists", () => {
    render(<StageReach total={0} responses={0} screenings={0} interviews={0} offers={0} title="Reach" headingLevel={4} />);
    expect(screen.getByText("Stage reach appears after the first application is imported.")).toBeInTheDocument();
  });
});

describe("ChartFrame", () => {
  it("keeps the hidden summary available to assistive technology only while the chart shows", async () => {
    render(<ChartFrame title="Custom" summary="Plain-language reading" table={{ columns: [{ header: "Name" }, { header: "Value", numeric: true }], rows: [["a", 1]] }}>{({ titleId, summaryId }) => <svg role="img" aria-labelledby={titleId} aria-describedby={summaryId} />}</ChartFrame>);
    expect(screen.getByRole("img", { name: "Custom" })).toHaveAccessibleDescription("Plain-language reading");
    await userEvent.click(screen.getByRole("button", { name: "View as table" }));
    expect(screen.queryByText("Plain-language reading")).not.toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1" })).toHaveAttribute("data-align", "end");
  });
});

describe("accessibility", () => {
  it("has no automated violations in chart or table view", async () => {
    const { container } = render(<main><h1>Charts</h1><h2>Section</h2>
      <BarChart title="Sources" items={items} headingLevel={3} /><ColumnChart title="Weekly" weeks={weeks} headingLevel={3} /><StageReach total={10} responses={5} screenings={2} interviews={1} offers={0} headingLevel={3} />
    </main>);
    expect(await scan(container)).toEqual([]);
    for (const toggle of screen.getAllByRole("button", { name: "View as table" })) await userEvent.click(toggle);
    expect(await scan(container)).toEqual([]);
  });
});
