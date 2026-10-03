import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { intelligenceApi } from "../lib/api";
import { app, app2 } from "../test/fixtures";
import { ApplicationPicker } from "./ApplicationPicker";

vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), intelligenceApi: vi.fn() }));

const api = vi.mocked(intelligenceApi);
const list = (applications = [app, app2]) => ({ applications, page: 0, pageSize: 25, total: applications.length, hasMore: false });
const queries = () => api.mock.calls.map(([path]) => new URLSearchParams(path.split("?")[1]));

function Harness({ excludeId, onPick }: { excludeId?: string; onPick?: (id: string) => void }) {
  const [value, setValue] = useState("");
  return <ApplicationPicker label="Merge into" value={value} excludeId={excludeId} required onChange={(id) => { setValue(id); onPick?.(id); }} />;
}

describe("ApplicationPicker", () => {
  it("looks applications up on its own and lists company, role and applied date", async () => {
    api.mockReset().mockResolvedValue(list());
    render(<Harness />);
    expect(await screen.findByRole("option", { name: "ExampleCo · Engineer · 2026-09-30" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /AnotherCo · Analyst/ })).toBeInTheDocument();
    expect(Object.fromEntries(queries()[0])).toEqual({ pageSize: "25" });
    expect(screen.getByLabelText("Merge into")).toBeRequired();
  });
  it("leaves out the application being edited", async () => {
    api.mockReset().mockResolvedValue(list());
    render(<Harness excludeId="app1" />);
    expect(await screen.findByRole("option", { name: /AnotherCo/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /ExampleCo/ })).not.toBeInTheDocument();
  });
  it("searches by the typed text and keeps the chosen application selectable when results change", async () => {
    api.mockReset().mockImplementation((async (path: string) => list(new URLSearchParams(path.split("?")[1]).get("q") === "Zed" ? [] : [app, app2])) as typeof intelligenceApi);
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.selectOptions(await screen.findByLabelText("Merge into"), "app2");
    expect(onPick).toHaveBeenCalledWith("app2");
    await userEvent.type(screen.getByLabelText("Search applications"), "Zed");
    await waitFor(() => expect(queries().some((query) => query.get("q") === "Zed")).toBe(true));
    expect(await screen.findByRole("option", { name: /AnotherCo/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Merge into")).toHaveValue("app2");
  });
  it("says when nothing matches, and while it is searching", async () => {
    let finish: (value: unknown) => void = () => {};
    api.mockReset().mockImplementation((() => new Promise<unknown>((done) => { finish = done; })) as typeof intelligenceApi);
    render(<Harness />);
    expect(screen.getByText("Searching…")).toBeInTheDocument();
    finish(list([]));
    expect(await screen.findByText("No matches. Try a different company or role.")).toBeInTheDocument();
  });
  it("shows the failure with a sign-in link", async () => {
    api.mockReset().mockRejectedValue(new Error("owner access required"));
    render(<Harness />);
    expect(await screen.findByRole("alert")).toHaveTextContent("owner access required");
    expect(screen.getByRole("link", { name: "Sign in to the private API" })).toBeInTheDocument();
  });
  it("clears the choice back to the placeholder", async () => {
    api.mockReset().mockResolvedValue(list());
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const select = await screen.findByLabelText("Merge into");
    await userEvent.selectOptions(select, "app1");
    await userEvent.selectOptions(select, "");
    expect(onPick).toHaveBeenLastCalledWith("");
  });
});
