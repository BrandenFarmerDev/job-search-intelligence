type Listener = (event: MediaQueryListEvent) => void;
type Bucket = "dark" | "wide" | "other";
const state = { dark: false, wide: false, listeners: { dark: new Set<Listener>(), wide: new Set<Listener>(), other: new Set<Listener>() } };
const bucket = (query: string): Bucket => query.includes("dark") ? "dark" : query.includes("width >= 64rem") ? "wide" : "other";
const notify = (which: Bucket, matches: boolean) => { for (const listener of [...state.listeners[which]]) listener({ matches } as MediaQueryListEvent); };

// Controllable stand-ins for matchMedia: the dark-scheme and desktop-width (>= 64rem) queries are independent; any other query never matches.
export const systemTheme = {
  get listenerCount() { return state.listeners.dark.size; },
  reset(dark = false) { state.dark = dark; state.listeners.dark.clear(); state.listeners.other.clear(); },
  change(dark: boolean) { state.dark = dark; notify("dark", dark); },
};
export const viewport = {
  get listenerCount() { return state.listeners.wide.size; },
  reset(wide = false) { state.wide = wide; state.listeners.wide.clear(); state.listeners.other.clear(); },
  change(wide: boolean) { state.wide = wide; notify("wide", wide); },
};

export function installMatchMedia() {
  window.matchMedia = (query: string) => ({
    get matches() { const which = bucket(query); return which === "dark" ? state.dark : which === "wide" && state.wide; },
    media: query,
    addEventListener: (_type: string, listener: Listener) => { state.listeners[bucket(query)].add(listener); },
    removeEventListener: (_type: string, listener: Listener) => { state.listeners[bucket(query)].delete(listener); },
  }) as unknown as MediaQueryList;
}
