import { describe, expect, it } from "vitest";
import { buildApplicationsQuery, presetOf, readView, statusGroups } from "./applications";
import { daysAgo, formatDate, formatDateTime, formatDuration, formatMonth, freshnessText, plural } from "./format";
import { eventTypes } from "@job-search/shared";

describe("readView", () => {
  it("reads filters, sort, page and page size from the URL", () => {
    const view = readView(new URLSearchParams("q=co&status=offer&sort=company&page=3&pageSize=50&unknown=1"));
    expect(view).toMatchObject({ filters: { q: "co", status: "offer", source: "" }, sort: "company", page: 3, pageSize: 50 });
  });
  it("falls back to safe defaults for values it does not recognise", () => {
    expect(readView(new URLSearchParams("sort=drop_table&page=-4&pageSize=9999"))).toMatchObject({ sort: "applied_desc", page: 0, pageSize: 25 });
    expect(readView(new URLSearchParams("page=abc")).page).toBe(0);
    expect(readView(new URLSearchParams("page=9999999")).page).toBe(1000);
    expect(readView(new URLSearchParams("page=2.9")).page).toBe(2);
  });
});

describe("buildApplicationsQuery", () => {
  it("names only the active filters", () => {
    expect(buildApplicationsQuery({ q: "", status: "offer", company: "A&B" }, { sort: "status", page: 0, pageSize: 25 })).toBe("status=offer&company=A%26B&sort=status&page=0&pageSize=25");
    expect(buildApplicationsQuery({})).toBe("");
  });
});

describe("presetOf", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  it("recognises the relative presets and treats everything else as custom", () => {
    expect(presetOf({ from: "", to: "" }, now)).toBe("any");
    expect(presetOf({ from: daysAgo(7, now), to: "" }, now)).toBe("7");
    expect(presetOf({ from: daysAgo(90, now), to: "" }, now)).toBe("90");
    expect(presetOf({ from: "2026-01-01", to: "" }, now)).toBe("custom");
    expect(presetOf({ from: daysAgo(7, now), to: "2026-10-01" }, now)).toBe("custom");
  });
});

describe("statusGroups", () => {
  it("places every event type in exactly one stage", () => {
    expect(statusGroups.flatMap((group) => group.types).sort()).toEqual([...eventTypes].sort());
  });
});

describe("format helpers", () => {
  it("shows stored dates as written and tolerates invalid input", () => {
    expect(formatDate("2026-09-30T23:59:00Z")).toBe("2026-09-30");
    expect(formatDateTime("not a date")).toBe("not a date");
    expect(formatDateTime("2026-10-01T18:30:00Z")).toContain("2026");
    expect(formatMonth("2026-08")).toBe("Aug 2026");
    expect(formatMonth("garbage")).toBe("garbage");
  });
  it("describes sync freshness", () => {
    expect(freshnessText(null)).toBe("No successful sync yet");
    expect(freshnessText("2026-10-01T18:30:00Z")).toMatch(/^Last successful sync: /);
  });
  it("formats durations and ignores impossible ones", () => {
    expect(formatDuration("2026-10-01T10:00:00Z", "2026-10-01T10:00:00.200Z")).toBe("under 1 s");
    expect(formatDuration("2026-10-01T10:00:00Z", "2026-10-01T10:00:12Z")).toBe("12 s");
    expect(formatDuration("2026-10-01T10:00:00Z", "2026-10-01T10:02:05Z")).toBe("2 min 5 s");
    expect(formatDuration("2026-10-01T10:00:10Z", "2026-10-01T10:00:00Z")).toBe("");
    expect(formatDuration("x", "y")).toBe("");
  });
  it("pluralizes counts", () => {
    expect(plural(1, "decision")).toBe("1 decision");
    expect(plural(0, "decision")).toBe("0 decisions");
  });
});
