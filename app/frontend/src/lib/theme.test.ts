import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { applyTheme, readPreference, useTheme } from "./theme";
import { systemTheme } from "../test/media";

const root = () => document.documentElement.dataset.theme;

describe("useTheme", () => {
  it("follows the system when nothing is stored and reacts to system changes", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current).toMatchObject({ preference: "system", resolved: "light" });
    expect(root()).toBe("light");
    act(() => systemTheme.change(true));
    expect(result.current.resolved).toBe("dark");
    expect(root()).toBe("dark");
  });

  it("persists an explicit choice and ignores later system changes", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPreference("dark"));
    expect(window.localStorage.getItem("qe-theme")).toBe("dark");
    expect(result.current).toMatchObject({ preference: "dark", resolved: "dark" });
    expect(systemTheme.listenerCount).toBe(0);
    act(() => systemTheme.change(false));
    expect(root()).toBe("dark");
    act(() => result.current.setPreference("system"));
    expect(root()).toBe("light");
    expect(systemTheme.listenerCount).toBe(1);
  });

  it("restores a stored preference and rejects unknown stored values", () => {
    window.localStorage.setItem("qe-theme", "dark");
    expect(renderHook(() => useTheme()).result.current.resolved).toBe("dark");
    window.localStorage.setItem("qe-theme", "sepia");
    expect(readPreference()).toBe("system");
  });

  it("removes its media listener on unmount", () => {
    const { unmount } = renderHook(() => useTheme());
    expect(systemTheme.listenerCount).toBe(1);
    unmount();
    expect(systemTheme.listenerCount).toBe(0);
  });

  it("keeps working when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe("system");
    act(() => result.current.setPreference("dark"));
    expect(result.current).toMatchObject({ preference: "dark", resolved: "dark" });
    expect(root()).toBe("dark");
  });

  it("falls back to light when the browser has no matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe("light");
    expect(applyTheme("system")).toBe("light");
  });
});
