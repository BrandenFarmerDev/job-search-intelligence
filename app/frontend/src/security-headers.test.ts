import { describe, expect, it } from "vitest";
import { pagesHeaders } from "./lib/pages-headers";

const headers = pagesHeaders("https://jobs-api.brandenfarmer.com");

describe("Cloudflare Pages security headers", () => {
  it("locks the owner interface to its required browser capabilities", () => {
    expect(headers).toContain("default-src 'none'");
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain("connect-src 'self' https://jobs-api.brandenfarmer.com");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toContain("Referrer-Policy: no-referrer");
    expect(headers).toContain("Permissions-Policy:");
    expect(headers).toContain("Cross-Origin-Opener-Policy: same-origin");
    expect(headers).toContain("Strict-Transport-Security: max-age=31536000; includeSubDomains");
  });
});
