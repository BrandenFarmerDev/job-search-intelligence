import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readSidebar, useSidebar } from "./sidebar";

const root = () => document.documentElement.dataset.sidebar;

describe("useSidebar", () => {
  it("starts expanded, applies the state to the document and stores each change", () => {
    const { result } = renderHook(() => useSidebar());
    expect(result.current.collapsed).toBe(false);
    expect(root()).toBe("expanded");
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(root()).toBe("collapsed");
    expect(window.localStorage.getItem("qe-sidebar")).toBe("collapsed");
    act(() => result.current.toggle());
    expect(root()).toBe("expanded");
    expect(window.localStorage.getItem("qe-sidebar")).toBe("expanded");
  });

  it("restores a stored collapsed state and treats unknown values as expanded", () => {
    window.localStorage.setItem("qe-sidebar", "collapsed");
    expect(renderHook(() => useSidebar()).result.current.collapsed).toBe(true);
    window.localStorage.setItem("qe-sidebar", "sideways");
    expect(readSidebar()).toBe("expanded");
  });

  it("keeps working when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    const { result } = renderHook(() => useSidebar());
    expect(result.current.collapsed).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(root()).toBe("collapsed");
  });
});
