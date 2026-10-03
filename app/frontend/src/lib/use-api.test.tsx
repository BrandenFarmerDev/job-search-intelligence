import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { intelligenceApi } from "./api";
import { useApiResource } from "./use-api";

vi.mock("./api", async (importOriginal) => ({ ...await importOriginal<typeof import("./api")>(), intelligenceApi: vi.fn() }));

const api = vi.mocked(intelligenceApi);
interface Request { path: string; signal?: AbortSignal; resolve: (value: unknown) => void; reject: (reason: unknown) => void }
function manual() {
  const requests: Request[] = [];
  api.mockReset().mockImplementation(((path: string, _method?: string, _body?: object, signal?: AbortSignal) => new Promise<unknown>((resolve, reject) => { requests.push({ path, signal, resolve, reject }); })) as typeof intelligenceApi);
  return requests;
}
function useResource(props: { path: string | null; key: number }) { return useApiResource<{ name: string }>(props.path, props.key, "Failed to load"); }
const use = (path: string | null, key = 0) => renderHook(useResource, { initialProps: { path, key } });

describe("useApiResource", () => {
  it("stays idle without a path", () => {
    manual();
    const { result } = use(null);
    expect(result.current).toEqual({ data: undefined, error: undefined, loading: false });
    expect(api).not.toHaveBeenCalled();
  });
  it("loads a path and exposes its data", async () => {
    const requests = manual();
    const { result } = use("/a");
    expect(result.current.loading).toBe(true);
    await act(async () => requests[0].resolve({ name: "A" }));
    expect(result.current).toEqual({ data: { name: "A" }, error: undefined, loading: false });
  });
  it("never shows another path's data, but keeps the same path's data while it refreshes", async () => {
    const requests = manual();
    const { result, rerender } = use("/a");
    await act(async () => requests[0].resolve({ name: "A" }));

    rerender({ path: "/a", key: 1 });
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual({ name: "A" });
    await act(async () => requests[1].resolve({ name: "A2" }));
    expect(result.current.data).toEqual({ name: "A2" });

    rerender({ path: "/b", key: 1 });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await act(async () => requests[2].resolve({ name: "B" }));
    expect(result.current.data).toEqual({ name: "B" });
  });
  it("aborts the superseded request and ignores its late answer", async () => {
    const requests = manual();
    const { result, rerender } = use("/a");
    rerender({ path: "/b", key: 0 });
    expect(requests[0].signal?.aborted).toBe(true);
    await act(async () => { requests[0].resolve({ name: "stale" }); requests[1].resolve({ name: "B" }); });
    expect(result.current.data).toEqual({ name: "B" });
  });
  it("reports an error for the current request only, with a fallback for non-Error failures", async () => {
    const requests = manual();
    const { result, rerender } = use("/a");
    await act(async () => requests[0].reject(new Error("owner access required")));
    expect(result.current).toMatchObject({ error: "owner access required", loading: false, data: undefined });

    rerender({ path: "/a", key: 1 });
    expect(result.current.error).toBeUndefined();
    await act(async () => requests[1].reject("boom"));
    expect(result.current.error).toBe("Failed to load");
  });
  it("does not update state after unmount", async () => {
    const requests = manual();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = use("/a");
    unmount();
    expect(requests[0].signal?.aborted).toBe(true);
    await act(async () => { requests[0].resolve({ name: "late" }); });
    await waitFor(() => expect(errors).not.toHaveBeenCalled());
  });
  it("does not report a failure that arrives after unmount", async () => {
    const requests = manual();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = use("/a");
    unmount();
    await act(async () => { requests[0].reject(new Error("late")); });
    expect(errors).not.toHaveBeenCalled();
  });
});
