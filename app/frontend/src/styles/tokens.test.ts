import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read from disk: Vitest replaces CSS imports, including ?raw, with an empty string.
const tokensCss = readFileSync("src/styles/tokens.css", "utf8");

type Theme = Record<string, string>;
const declarations = (selector: RegExp): Theme => {
  const body = selector.exec(tokensCss)?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/--qe-color-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(([, name, hex]) => [name, hex]));
};
const light = declarations(/:where\(\.qe-app\)\s*\{([^}]*)\}/);
const dark = { ...light, ...declarations(/:where\(\.qe-app\[data-theme="dark"\]\)\s*\{([^}]*)\}/) };

const channel = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
const ratio = (first: string, second: string) => { const [a, b] = [luminance(first), luminance(second)].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); };

const tones: [string, string][] = [["info", "info-surface"], ["success", "success-surface"], ["warning", "warning-surface"], ["danger", "danger-surface"], ["text-secondary", "surface-subtle"]];
const textPairs: [string, string][] = [["selected-fg", "primary-soft"], ["selected-fg", "surface-selected"], ["selected-fg", "surface"], ["selected-fg", "surface-hover"], ["text-secondary", "surface-hover"], ...tones];
const controlPairs: [string, string][] = [["border-control", "surface"], ["border-control", "canvas"]];

describe.each([["light", light], ["dark", dark]])("%s theme contrast", (_name, theme) => {
  it.each(textPairs)("keeps %s readable on %s (4.5:1)", (foreground, background) => {
    expect(ratio(theme[foreground], theme[background])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(controlPairs)("keeps %s visible on %s (3:1)", (foreground, background) => {
    expect(ratio(theme[foreground], theme[background])).toBeGreaterThanOrEqual(3);
  });
});
