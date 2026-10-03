import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
// Keep in sync with public/theme-init.js, which resolves the theme before first paint.
const STORAGE_KEY = "qe-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const isPreference = (value: unknown): value is ThemePreference => value === "light" || value === "dark" || value === "system";

export function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isPreference(stored) ? stored : "system";
  } catch { return "system"; }
}
const systemPrefersDark = () => window.matchMedia?.(DARK_QUERY).matches ?? false;
const resolve = (preference: ThemePreference, dark: boolean): ResolvedTheme => preference === "system" ? (dark ? "dark" : "light") : preference;

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolve(preference, systemPrefersDark());
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export function useTheme() {
  const [preference, setStoredPreference] = useState<ThemePreference>(readPreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  useEffect(() => {
    applyTheme(preference);
    if (preference !== "system" || !window.matchMedia) return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => { setSystemDark(event.matches); applyTheme("system"); };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);
  const setPreference = useCallback((next: ThemePreference) => {
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* The preference still applies for this session. */ }
    setSystemDark(systemPrefersDark());
    setStoredPreference(next);
  }, []);
  return { preference, resolved: resolve(preference, systemDark), setPreference };
}
