import { useEffect, useState } from "react";

export type SidebarState = "expanded" | "collapsed";
// Keep in sync with public/theme-init.js, which applies the saved state before first paint.
const STORAGE_KEY = "qe-sidebar";

export function readSidebar(): SidebarState {
  try { return window.localStorage.getItem(STORAGE_KEY) === "collapsed" ? "collapsed" : "expanded"; } catch { return "expanded"; }
}

export function useSidebar() {
  const [state, setState] = useState<SidebarState>(readSidebar);
  useEffect(() => { document.documentElement.dataset.sidebar = state; }, [state]);
  function toggle() {
    const next = state === "collapsed" ? "expanded" : "collapsed";
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* The state still applies for this session. */ }
    setState(next);
  }
  return { collapsed: state === "collapsed", toggle };
}
