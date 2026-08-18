/** Parses exact browser origins; paths, wildcards, and credentials are invalid. */
export function parseAllowedOrigins(value: string): string[] {
  const origins = value.split(",").map((item) => item.trim()).filter(Boolean);
  const unique = new Set<string>();
  for (const origin of origins) {
    if (origin === "*") throw new Error("CORS_ALLOWED_ORIGINS must not contain a wildcard");
    let url: URL;
    try { url = new URL(origin); }
    catch { throw new Error(`CORS_ALLOWED_ORIGINS contains an invalid origin: ${origin}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`CORS_ALLOWED_ORIGINS must contain exact http(s) origins: ${origin}`);
    }
    unique.add(origin);
  }
  return [...unique];
}

/** Production browser entry points must use explicitly configured HTTPS origins. */
export function assertProductionAllowedOrigins(origins: string[]): void {
  if (origins.length === 0) throw new Error("production requires at least one CORS allowed origin");
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      throw new Error(`production CORS origin must be a non-localhost HTTPS origin: ${origin}`);
    }
  }
}
