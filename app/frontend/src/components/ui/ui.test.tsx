import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Alert, Button, DataTable, Drawer, EmptyState, Field, FilterChip, Kpi, Pagination, Panel, SearchIcon, SearchInput, SegmentedControl, Skeleton, StatusBadge, Tabs,
  describeStatus, humanize, type Column,
} from ".";

afterEach(() => vi.useRealTimers());
const scan = async (container: HTMLElement) => (await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations;

describe("Icon", () => {
  it("keeps the base class when a class name is passed", () => {
    const { container } = render(<SearchIcon className="qe-search-icon" size="lg" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveClass("qe-icon", "qe-search-icon");
    expect(svg).toHaveAttribute("data-size", "lg");
  });
});

describe("Button", () => {
  it("is a non-submitting button with variant data attributes", async () => {
    const click = vi.fn();
    render(<form><Button variant="primary" size="compact" onClick={click}>Save changes</Button></form>);
    const button = screen.getByRole("button", { name: "Save changes" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("data-variant", "primary");
    expect(button).toHaveAttribute("data-size", "compact");
    await userEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
  });
  it("blocks duplicate submissions and announces busy state while loading", async () => {
    const click = vi.fn();
    render(<Button loading iconOnly onClick={click}>Sync</Button>);
    const button = screen.getByRole("button", { name: "Sync" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("data-icon-only", "true");
    await userEvent.click(button);
    expect(click).not.toHaveBeenCalled();
  });
});

describe("Field", () => {
  it("links label, help and error to the control", () => {
    render(<Field label="Company" help="As written on the posting" error="Enter a company" required>{(control) => <input {...control} />}</Field>);
    const input = screen.getByLabelText(/Company/);
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("As written on the posting Enter a company");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a company");
  });
  it("omits invalid and description attributes when the field is clean", () => {
    render(<Field label="Role">{(control) => <input {...control} />}</Field>);
    const input = screen.getByLabelText("Role");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });
});

describe("SearchInput", () => {
  function Harness({ delay, onChange }: { delay?: number; onChange: (value: string) => void }) {
    const [value, setValue] = useState("");
    return <><SearchInput label="Search" value={value} delay={delay} placeholder="Company or role" onChange={(next) => { setValue(next); onChange(next); }} />
      <button type="button" onClick={() => setValue("external")}>Set externally</button></>;
  }
  // fireEvent keeps these tests synchronous so fake timers cannot stall Testing Library's async helpers.
  const type = (box: HTMLElement, text: string) => fireEvent.change(box, { target: { value: text } });
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  it("debounces typing for 300ms and reports the final value once", () => {
    vi.useFakeTimers(); const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const box = screen.getByRole("searchbox", { name: "Search" });
    type(box, "ac"); wait(200); type(box, "acme");
    wait(299); expect(onChange).not.toHaveBeenCalled();
    wait(1); expect(onChange).toHaveBeenCalledExactlyOnceWith("acme");
  });
  it("clears with the button and with Escape, but leaves Escape alone when empty", () => {
    vi.useFakeTimers(); const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const box = screen.getByRole("searchbox");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    type(box, "ab"); fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(box).toHaveValue(""); expect(onChange).toHaveBeenLastCalledWith("");
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    type(box, "cd"); fireEvent.keyDown(box, { key: "Escape" });
    expect(box).toHaveValue(""); expect(onChange).toHaveBeenCalledTimes(2);
    wait(1000); expect(onChange).toHaveBeenCalledTimes(2);
  });
  it("commits immediately on Enter, ignores other keys, and keeps newer typing over its own echo", () => {
    vi.useFakeTimers(); const onChange = vi.fn();
    render(<Harness delay={50} onChange={onChange} />);
    const box = screen.getByRole("searchbox");
    type(box, "a"); fireEvent.keyDown(box, { key: "x" }); expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("a");
    type(box, "ab"); expect(box).toHaveValue("ab");
    wait(50); expect(onChange).toHaveBeenLastCalledWith("ab");
  });
  it("accepts an external reset and drops a notification typed before it", () => {
    vi.useFakeTimers(); const onChange = vi.fn();
    render(<Harness delay={50} onChange={onChange} />);
    const box = screen.getByRole("searchbox");
    type(box, "stale");
    fireEvent.click(screen.getByRole("button", { name: "Set externally" }));
    expect(box).toHaveValue("external");
    wait(100); expect(onChange).not.toHaveBeenCalled();
  });
  it("cancels a pending notification on unmount", () => {
    vi.useFakeTimers(); const onChange = vi.fn();
    const { unmount } = render(<Harness onChange={onChange} />);
    type(screen.getByRole("searchbox"), "x"); unmount();
    wait(1000); expect(onChange).not.toHaveBeenCalled();
  });
});
describe("StatusBadge", () => {
  it.each([
    ["interview_scheduled", "info"], ["screening", "info"], ["assessment_requested", "info"], ["offer", "success"], ["matched", "success"],
    ["rejection", "neutral"], ["withdrawal", "neutral"], ["position_closed", "neutral"], ["needs_review", "warning"], ["conflict", "warning"],
    ["email_only", "neutral"], ["sheet_only", "neutral"], ["application_submitted", "neutral"],
    ["completed", "success"], ["connected", "success"], ["imported", "success"], ["failed", "danger"],
  ])("maps %s to the %s tone", (value, tone) => {
    expect(describeStatus(value).tone).toBe(tone);
  });
  it("always shows readable text alongside an icon", () => {
    const { container } = render(<StatusBadge value="needs_review" />);
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(container.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(humanize("")).toBe("Unknown");
  });
});

describe("Panel, Kpi, Alert, EmptyState and Skeleton", () => {
  it("labels a panel by its heading and renders optional parts", () => {
    render(<Panel title="Sources" description="Where applications come from" actions={<Button>Export</Button>} headingLevel={3} flush>Body</Panel>);
    const region = screen.getByRole("region", { name: "Sources" });
    expect(within(region).getByRole("heading", { level: 3 })).toHaveTextContent("Sources");
    expect(region).toHaveAttribute("data-flush", "true");
    expect(within(region).getByRole("button", { name: "Export" })).toBeInTheDocument();
  });
  it("renders a bare panel with a second-level heading", () => {
    render(<Panel title="Plain">Body</Panel>);
    expect(screen.getByRole("heading", { level: 2, name: "Plain" })).toBeInTheDocument();
  });
  it("shows a KPI with unit, context and link", () => {
    render(<Kpi label="Responses" value={12} unit="%" context="Last 30 days" link={<a href="#detail">See detail</a>} />);
    expect(screen.getByText("Responses")).toBeInTheDocument();
    expect(screen.getByText("12")).toHaveClass("qe-kpi-value");
    expect(screen.getByText("%")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See detail" })).toBeInTheDocument();
    render(<Kpi label="Offers" value={0} />);
    expect(screen.getByText("Offers")).toBeInTheDocument();
  });
  it("uses an assertive role only for warnings and errors", () => {
    render(<>{(["info", "success", "warning", "danger"] as const).map((tone) => <Alert key={tone} tone={tone} title={`${tone} title`} className="extra">Detail</Alert>)}<Alert>Plain</Alert></>);
    expect(screen.getAllByRole("alert").map((node) => node.getAttribute("data-tone"))).toEqual(["warning", "danger"]);
    expect(screen.getAllByRole("status").map((node) => node.getAttribute("data-tone"))).toEqual(["info", "success", "info"]);
  });
  it("distinguishes a dataset-empty state from a filtered-empty state", () => {
    render(<><EmptyState title="No applications yet" description="Import to begin" action={<Button>Import</Button>} /><EmptyState variant="filtered" title="No matches" /></>);
    const [dataset, filtered] = document.querySelectorAll(".qe-empty");
    expect(dataset).toHaveAttribute("data-variant", "dataset"); expect(filtered).toHaveAttribute("data-variant", "filtered");
    expect(screen.getByText("Import to begin")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Import" })).toBeInTheDocument();
  });
  it("renders hidden skeleton placeholders", () => {
    const { container } = render(<><Skeleton /><Skeleton variant="block" width="short" /><Skeleton lines={3} /></>);
    expect(container.querySelectorAll(".qe-skeleton")).toHaveLength(5);
    expect(container.querySelectorAll("[aria-hidden='true']")).toHaveLength(3);
  });
});

describe("FilterChip", () => {
  it("names the filter it removes", async () => {
    const remove = vi.fn();
    render(<FilterChip label="Company" value="Acme" onRemove={remove} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove filter: Company: Acme" }));
    expect(remove).toHaveBeenCalledOnce();
  });
});

describe("Pagination", () => {
  it("summarizes the visible range and steps between pages", async () => {
    const change = vi.fn();
    const { rerender } = render(<Pagination page={0} pageSize={25} total={63} onPageChange={change} />);
    expect(screen.getByText("1–25 of 63")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("button", { name: /Previous/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(change).toHaveBeenCalledWith(1);
    rerender(<Pagination page={2} pageSize={25} total={63} onPageChange={change} />);
    expect(screen.getByText("51–63 of 63")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /Previous/ }));
    expect(change).toHaveBeenLastCalledWith(1);
  });
  it("reports an empty result and offers page sizes", async () => {
    const size = vi.fn();
    render(<Pagination page={0} pageSize={25} total={0} onPageChange={vi.fn()} pageSizes={[25, 50]} onPageSizeChange={size} label="Applications pages" />);
    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Applications pages" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Rows per page"), "50");
    expect(size).toHaveBeenCalledWith(50);
  });
  it("hides the page-size control unless it can be used", () => {
    render(<Pagination page={0} pageSize={25} total={5} onPageChange={vi.fn()} pageSizes={[25, 50]} />);
    expect(screen.queryByLabelText("Rows per page")).not.toBeInTheDocument();
  });
});

describe("Tabs", () => {
  const items = [{ id: "a", label: "Overview" }, { id: "b", label: "Sources" }, { id: "c", label: "Roles" }];
  function Harness({ initial = "a" }: { initial?: string }) {
    const [value, setValue] = useState(initial);
    return <Tabs label="Insights" tabs={items} value={value} onChange={setValue}>{`Panel ${value}`}</Tabs>;
  }
  it("exposes one tab stop and a labelled panel", () => {
    render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tablist", { name: "Insights" })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toHaveTextContent("Panel a");
  });
  it("moves with arrows, Home and End, wrapping at both ends", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("tab", { name: "Overview" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Roles" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel c");
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("x");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
  });
  it("selects on click and falls back to the first tab for an unknown value", async () => {
    const { unmount } = render(<Harness />);
    await userEvent.click(screen.getByRole("tab", { name: "Sources" }));
    expect(screen.getByRole("tabpanel", { name: "Sources" })).toBeInTheDocument();
    unmount();
    render(<Harness initial="missing" />);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("SegmentedControl", () => {
  function Harness({ onChange = () => {} }: { onChange?: (value: string) => void }) {
    const [value, setValue] = useState("chart");
    return <SegmentedControl label="Display" value={value} onChange={(next) => { setValue(next); onChange(next); }}
      options={[{ value: "chart", label: "Chart" }, { value: "table", label: "Table" }, { value: "map", label: <SearchIcon />, name: "Map view" }]} />;
  }
  it("marks only the current option as pressed and reports the chosen value", async () => {
    const change = vi.fn();
    render(<Harness onChange={change} />);
    const group = within(screen.getByRole("group", { name: "Display" }));
    expect(group.getAllByRole("button").map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    await userEvent.click(group.getByRole("button", { name: "Table" }));
    expect(change).toHaveBeenCalledWith("table");
    expect(group.getAllByRole("button").map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    expect(group.getByRole("button", { name: "Table" })).not.toHaveAttribute("title");
  });
  it("names an icon-only option and has no automated violations", async () => {
    const { container } = render(<Harness />);
    expect(screen.getByRole("button", { name: "Map view" })).toHaveAttribute("title", "Map view");
    expect(await scan(container)).toEqual([]);
  });
});

describe("Drawer", () => {
  function Harness({ fallback = false }: { fallback?: boolean }) {
    const [open, setOpen] = useState(false); const [opener, setOpener] = useState(true);
    const rest = useRef<HTMLButtonElement>(null);
    return <>
      {opener && <button type="button" onClick={() => setOpen(true)}>Open details</button>}
      <button type="button" ref={rest}>Fallback target</button>
      <button type="button" onClick={() => setOpener(false)}>Remove opener</button>
      <button type="button" onClick={() => setOpen(false)}>Close from page</button>
      <Drawer open={open} title="Application details" onClose={() => setOpen(false)} fallbackFocusRef={fallback ? rest : undefined}><p>Drawer body</p></Drawer>
    </>;
  }
  const dialog = () => document.querySelector("dialog") as HTMLDialogElement;

  it("opens modally with a titled Close button and returns focus to the opener", async () => {
    const user = userEvent.setup(); render(<Harness />);
    expect(dialog()).not.toHaveAttribute("open");
    await user.click(screen.getByRole("button", { name: "Open details" }));
    expect(dialog()).toHaveAttribute("open");
    expect(dialog()).toHaveAccessibleName("Application details");
    expect(screen.getByText("Drawer body")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(dialog()).not.toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Open details" })).toHaveFocus();
    expect(screen.queryByText("Drawer body")).not.toBeInTheDocument();
  });
  it("closes on Escape and when the parent closes it", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open details" }));
    act(() => dialog().close());
    expect(screen.queryByText("Drawer body")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open details" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Open details" }));
    await user.click(screen.getByRole("button", { name: "Close from page" }));
    expect(dialog()).not.toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Open details" })).toHaveFocus();
  });
  it("moves focus to the fallback when the opener has gone", async () => {
    const user = userEvent.setup(); render(<Harness fallback />);
    await user.click(screen.getByRole("button", { name: "Open details" }));
    await user.click(screen.getByRole("button", { name: "Remove opener" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Fallback target" })).toHaveFocus();
  });
  it("tolerates a missing opener and fallback", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open details" }));
    await user.click(screen.getByRole("button", { name: "Remove opener" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(dialog()).not.toHaveAttribute("open");
  });
});

interface Row { id: string; company: string; count: number }
const rows: Row[] = [{ id: "1", company: "Acme", count: 4 }, { id: "2", company: "Globex", count: 12 }];
const columns: Column<Row>[] = [
  { key: "company", header: "Company", sortKey: "company", truncate: true, render: (row) => row.company },
  { key: "count", header: "Count", align: "end", sortKey: "count", render: (row) => row.count },
  { key: "plain", header: "Notes", render: () => <b>note</b>, truncate: true },
];
const table = (props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) => <DataTable caption="Applications" columns={columns} rows={rows} rowKey={(row) => row.id} {...props} />;

describe("DataTable", () => {
  it("renders headers, numeric alignment, a trailing action column and the current row", async () => {
    const act1 = vi.fn();
    render(table({ currentRowKey: "2", action: { header: "Row actions", render: (row) => <Button onClick={() => act1(row.id)}>Open {row.company}</Button> } }));
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["Company", "Count", "Notes", "Row actions"]);
    expect(headers[3].firstElementChild).toHaveClass("qe-visually-hidden");
    expect(screen.getByText("12").closest("td")).toHaveAttribute("data-align", "end");
    expect(screen.getByRole("columnheader", { name: "Count" })).toHaveAttribute("data-align", "end");
    expect(screen.getAllByRole("row")[2]).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Acme")).toHaveAttribute("title", "Acme");
    await userEvent.click(screen.getByRole("button", { name: "Open Acme" }));
    expect(act1).toHaveBeenCalledWith("1");
  });
  it("exposes sort state with aria-sort and sortable header buttons", async () => {
    const onSort = vi.fn();
    const { rerender } = render(table({ onSort }));
    await userEvent.click(screen.getByRole("button", { name: "Count" }));
    expect(onSort).toHaveBeenCalledWith("count");
    expect(screen.getByRole("columnheader", { name: "Count" })).not.toHaveAttribute("aria-sort");
    rerender(table({ onSort, sort: { key: "count", direction: "ascending" } }));
    expect(screen.getByRole("columnheader", { name: "Count" })).toHaveAttribute("aria-sort", "ascending");
    rerender(table({ onSort, sort: { key: "count", direction: "descending" } }));
    expect(screen.getByRole("columnheader", { name: "Count" })).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: "Company" })).not.toHaveAttribute("aria-sort");
  });
  it("shows plain headers when sorting is not wired up", () => {
    render(table());
    expect(screen.queryByRole("button", { name: "Count" })).not.toBeInTheDocument();
  });
  it("shows a loading skeleton, a default or custom empty row, and keeps them distinct", () => {
    const { rerender, container } = render(table({ loading: true }));
    expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelectorAll(".qe-skeleton")).toHaveLength(15);
    rerender(table({ rows: [] }));
    expect(screen.getByText("No records to show.")).toBeInTheDocument();
    rerender(table({ rows: [], empty: <EmptyState variant="filtered" title="No matches" />, action: { header: "Actions", render: () => null } }));
    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.getByRole("cell")).toHaveAttribute("colspan", "4");
  });
  it("offers a keyboard-reachable scroll region and a sideways-scroll cue only when columns overflow", () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(900);
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(400);
    render(table());
    expect(screen.getByRole("region", { name: "Applications table" })).toHaveAttribute("tabindex", "0");
    expect(screen.queryByText(/Scroll sideways/)).not.toBeInTheDocument();
    act(() => observers.forEach((callback) => callback()));
    expect(screen.getByText(/Scroll sideways/)).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("has no automated violations across the component set", async () => {
    const { container } = render(<main>
      <h1>Components</h1>
      <Field label="Name">{(control) => <input {...control} />}</Field>
      <SearchInput label="Search applications" value="acme" onChange={() => {}} />
      <Button variant="primary">Save changes</Button><Button loading>Syncing</Button>
      <StatusBadge value="offer" /><StatusBadge value="needs_review" /><FilterChip label="Source" value="Email" onRemove={() => {}} />
      <Alert tone="danger" title="Import failed">Retry is safe.</Alert><EmptyState title="Nothing here" />
      <Panel title="Summary"><Kpi label="Applications" value={63} /><Skeleton lines={2} /></Panel>
      <Tabs label="Views" tabs={[{ id: "a", label: "One" }, { id: "b", label: "Two" }]} value="a" onChange={() => {}}>Tab body</Tabs>
      {table({ onSort: () => {}, sort: { key: "company", direction: "ascending" } })}
      <Pagination page={0} pageSize={25} total={63} onPageChange={() => {}} pageSizes={[25, 50]} onPageSizeChange={() => {}} />
      <Drawer open title="Details" onClose={() => {}}>Body</Drawer>
    </main>);
    expect(await scan(container)).toEqual([]);
  });
});

