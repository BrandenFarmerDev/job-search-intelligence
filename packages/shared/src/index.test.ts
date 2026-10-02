import { describe, expect, it } from "vitest";
import { isHealthResponse } from "./index";

describe("health contract", () => {
  const valid = { status: "ok", service: "job-search-intelligence-api", timestamp: "2026-10-01T00:00:00.000Z" };
  it("accepts a valid service response", () => expect(isHealthResponse(valid)).toBe(true));
  it.each([null, undefined, 42, "ok", {}, { ...valid, status: "down" }, { ...valid, service: "other-api" },
    { ...valid, timestamp: 42 }, { ...valid, timestamp: "invalid" }])("rejects malformed data: %j", (value) => {
    expect(isHealthResponse(value)).toBe(false);
  });
});
