type Listener = (event: MediaQueryListEvent) => void;
const state = { dark: false, listeners: new Set<Listener>() };

// Controllable stand-in for matchMedia; only the dark-scheme query ever matches.
export const systemTheme = {
  get listenerCount() { return state.listeners.size; },
  reset(dark = false) { state.dark = dark; state.listeners.clear(); },
  change(dark: boolean) { state.dark = dark; for (const listener of [...state.listeners]) listener({ matches: dark } as MediaQueryListEvent); },
};

export function installMatchMedia() {
  window.matchMedia = (query: string) => ({
    get matches() { return query.includes("dark") && state.dark; },
    media: query,
    addEventListener: (_type: string, listener: Listener) => { state.listeners.add(listener); },
    removeEventListener: (_type: string, listener: Listener) => { state.listeners.delete(listener); },
  }) as unknown as MediaQueryList;
}
