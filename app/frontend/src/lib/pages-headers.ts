export function pagesHeaders(apiOrigin: string): string {
  const connectSource = apiOrigin === "'self'" ? "'self'" : `'self' ${apiOrigin}`;
  return `/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${connectSource}; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;
}
