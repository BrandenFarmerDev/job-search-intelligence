import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { installMatchMedia, systemTheme } from "./media";

// jsdom lacks modal dialog behaviour; these doubles track `open` and fire `close` like the browser.
HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function close() {
  if (!this.hasAttribute("open")) return;
  this.removeAttribute("open");
  this.dispatchEvent(new Event("close"));
};

beforeEach(() => { systemTheme.reset(); installMatchMedia(); });
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  window.localStorage.clear(); delete document.documentElement.dataset.theme;
});
