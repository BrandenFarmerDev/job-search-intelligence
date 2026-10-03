import { expect, it } from "vitest";
import type { ApplicationRecord } from "@job-search/shared";
import { analytics, dashboard, weeklyCounts } from "./dashboard";
import { fixture } from "../test/fixtures";

const make = (id: string, over: Partial<ApplicationRecord> = {}): ApplicationRecord => ({ id, company: "Co", role: "Engineer", requisition_id: null, application_url: null, applied_at: "2026-09-01", status: "application_submitted", source: "sheet", reconciliation: "matched", excluded: 0, updated_at: "2026-09-01", ...over });
const now = Date.parse("2026-10-07T12:00:00Z");

it("aggregates outcomes by source, company and role with the same rules as the headline metrics", () => {
  const apps = [make("a", { source: "email", company: "Alpha" }), make("b", { company: "Alpha", role: "Designer" }), make("c", { company: "Beta" })];
  const events = [
    { application_id: "a", type: "screening", occurred_at: "2026-09-03" }, { application_id: "a", type: "interview_scheduled", occurred_at: "2026-09-05" },
    { application_id: "b", type: "rejection", occurred_at: "2026-09-02" }, { application_id: "b", type: "offer", occurred_at: "2026-09-08" },
    { application_id: "c", type: "follow_up_sent", occurred_at: "2026-09-02" },
  ];
  const { outcomes, metrics } = analytics(apps, events, now);
  expect(outcomes.source.email).toEqual({ applied: 1, responses: 1, screenings: 1, interviews: 1, offers: 0, rejections: 0, medianResponseDays: 2 });
  expect(outcomes.source.sheet).toEqual({ applied: 2, responses: 1, screenings: 0, interviews: 0, offers: 1, rejections: 1, medianResponseDays: 1 });
  expect(outcomes.company.Alpha).toMatchObject({ applied: 2, responses: 2, medianResponseDays: 1.5 });
  expect(outcomes.company.Beta).toMatchObject({ applied: 1, responses: 0, medianResponseDays: null });
  expect(outcomes.role.Engineer.applied).toBe(2);
  expect(Object.values(outcomes.source).reduce((sum, item) => sum + item.responses, 0)).toBe(metrics.responses);
});

it("reports a nullable median that handles none, odd, even and unknown-date responses", () => {
  expect(analytics([make("a")], [], now).medianFirstResponseDays).toBeNull();
  const apps = ["a", "b", "c", "d"].map((id) => make(id));
  const reply = (id: string, day: number, extra = {}) => ({ application_id: id, type: "screening", occurred_at: `2026-09-${String(1 + day).padStart(2, "0")}`, ...extra });
  expect(analytics(apps, [reply("a", 1), reply("b", 5), reply("c", 9)], now).medianFirstResponseDays).toBe(5);
  expect(analytics(apps, [reply("a", 1), reply("b", 5), reply("c", 9), reply("d", 3)], now).medianFirstResponseDays).toBe(4);
  const undated = analytics(apps, [reply("a", 7, { date_known: 0 })], now);
  expect(undated.medianFirstResponseDays).toBeNull();
  expect(undated.outcomes.company.Co).toMatchObject({ responses: 1, medianResponseDays: null });
});

it("zero-fills 26 UTC Monday weeks and moves Sunday into the prior week", () => {
  const apps = ["2026-10-04T23:59:59Z", "2026-10-05T00:00:00Z", "2026-10-07", "2026-04-13", "2026-04-12", "nonsense", "2026-10-20"].map((date, index) => make(String(index), { applied_at: date }));
  const weekly = weeklyCounts(apps, now);
  expect(weekly).toHaveLength(26);
  expect(weekly[25]).toEqual({ weekStart: "2026-10-05", count: 2 });
  expect(weekly[24]).toEqual({ weekStart: "2026-09-28", count: 1 });
  expect(weekly[0]).toEqual({ weekStart: "2026-04-13", count: 1 });
  expect(weekly.reduce((sum, week) => sum + week.count, 0)).toBe(4);
  expect(weekly.map((week) => week.weekStart)).toEqual([...weekly.map((week) => week.weekStart)].sort());
  expect(weekly.filter((week) => week.count === 0)).toHaveLength(23);
});

it("keeps one week across a year boundary and is deterministic for a given clock", () => {
  const apps = [make("a", { applied_at: "2026-12-28" }), make("b", { applied_at: "2027-01-03T23:00:00Z" }), make("c", { applied_at: "2026-12-27" })];
  const sunday = Date.parse("2027-01-03T23:30:00Z");
  const weekly = weeklyCounts(apps, sunday);
  expect(weekly[25]).toEqual({ weekStart: "2026-12-28", count: 2 });
  expect(weekly[24]).toEqual({ weekStart: "2026-12-21", count: 1 });
  expect(weeklyCounts(apps, sunday)).toEqual(weekly);
  expect(weeklyCounts(apps, sunday + 1000)[25].weekStart).toBe("2026-12-28");
  expect(weeklyCounts([], Date.parse("2027-01-04T00:00:00Z"))[25].weekStart).toBe("2027-01-04");
});

it("treats prototype-like names as ordinary data and serializes them safely", () => {
  const { outcomes, groups } = analytics([make("a", { company: "__proto__", role: "constructor" }), make("b", { company: "__proto__", role: "constructor" })], [], now);
  expect(Object.keys(outcomes.company)).toEqual(["__proto__"]);
  expect(Object.getOwnPropertyDescriptor(outcomes.company, "__proto__")?.value).toMatchObject({ applied: 2 });
  expect(Object.getOwnPropertyDescriptor(groups.company, "__proto__")?.value).toBe(2);
  expect(Object.getPrototypeOf(outcomes.company)).toBe(Object.prototype);
  expect(JSON.stringify(outcomes.company)).toContain('"__proto__":{"applied":2');
  expect(JSON.parse(JSON.stringify(outcomes.role)).constructor.applied).toBe(2);
});

it("caps company and role outcomes at the 50 largest groups, ordering ties by name", () => {
  const apps = Array.from({ length: 60 }, (_, index) => make(`app${index}`, { company: `Company ${String(index).padStart(2, "0")}`, role: `Role ${String(59 - index).padStart(2, "0")}` }));
  apps.push(make("extra", { company: "Company 59", role: "Role 00" }), make("source", { company: "Company 59", source: "email" }));
  const { outcomes } = analytics(apps, [], now);
  const companies = Object.keys(outcomes.company);
  expect(companies).toHaveLength(50);
  expect(companies[0]).toBe("Company 59");
  expect(companies).toContain("Company 00");
  expect(companies).not.toContain("Company 55");
  expect(Object.keys(outcomes.role)).toHaveLength(50);
  expect(Object.keys(outcomes.source)).toEqual(["sheet", "email"]);
});

it("reports the latest successful sync only and otherwise no freshness", async () => {
  const { env, db, close } = fixture();
  expect((await dashboard(env)).lastSuccessfulSyncAt).toBeNull();
  const insert = (id: string, status: string, finished: string | null) => db.prepare("INSERT INTO sync_runs(id,trigger,status,started_at,finished_at) VALUES(?,?,?,?,?)").bind(id, "manual", status, "2026-10-01T00:00:00Z", finished).run();
  await insert("old", "completed", "2026-10-01T01:00:00Z"); await insert("new", "completed", "2026-10-02T01:00:00Z");
  await insert("failed", "failed", "2026-10-03T01:00:00Z"); await insert("running", "running", null);
  const view = await dashboard(env);
  expect(view.lastSuccessfulSyncAt).toBe("2026-10-02T01:00:00Z");
  expect(view.weekly).toHaveLength(26); expect(view.medianFirstResponseDays).toBeNull();
  close();
});
