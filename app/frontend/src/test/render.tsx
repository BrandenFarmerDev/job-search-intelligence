import { useEffect } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { vi } from "vitest";
import axe from "axe-core";
import { App } from "../App";
import { intelligenceApi } from "../lib/api";
import { apiImplementation, makeState, type ApiState } from "./fixtures";

// Memory history has no browser Back button, so tests call `history.back()`.
export const history = { back: () => {} };
function LocationProbe() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => { history.back = () => navigate(-1); }, [navigate]);
  return <output data-testid="location">{pathname}{search}</output>;
}

// Renders the real app at a route with the API mocked; the caller's file must `vi.mock("../lib/api", ...)` first.
export type Handler = (path: string, method: string, body: unknown) => unknown;
// A handler may return a response, throw to fail the request, or return nothing to use the default.
export function renderApp(path = "/", state: ApiState = makeState(), handler?: Handler) {
  const fallback = apiImplementation(state);
  vi.mocked(intelligenceApi).mockReset().mockImplementation((async (requested: string, method = "GET", body?: unknown) => handler?.(requested, method, body) ?? fallback(requested)) as typeof intelligenceApi);
  return { state, ...render(<MemoryRouter initialEntries={[path]}><App /><LocationProbe /></MemoryRouter>) };
}
export const calls = (path: string | RegExp) => vi.mocked(intelligenceApi).mock.calls.filter(([called]) => typeof path === "string" ? called === path : path.test(called));
export const violations = async (container: HTMLElement) => (await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations;

