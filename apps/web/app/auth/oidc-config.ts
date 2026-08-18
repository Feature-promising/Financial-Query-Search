export interface BrowserOidcConfig {
  authority: string;
  clientId: string;
  redirectUri?: string;
  scope: string;
}

type BrowserEnvironment = Record<string, string | undefined>;

/** Validates only public OIDC metadata; browser clients must never receive a secret. */
export function resolveBrowserOidcConfig(environment: BrowserEnvironment = process.env): BrowserOidcConfig | undefined {
  const authority = environment.NEXT_PUBLIC_OIDC_AUTHORITY;
  const clientId = environment.NEXT_PUBLIC_OIDC_CLIENT_ID;
  if (!authority && !clientId) return undefined;
  if (!authority || !clientId) throw new Error("NEXT_PUBLIC_OIDC_AUTHORITY and NEXT_PUBLIC_OIDC_CLIENT_ID must be configured together");
  assertHttpsUrl("NEXT_PUBLIC_OIDC_AUTHORITY", authority, environment.NODE_ENV);
  const redirectUri = environment.NEXT_PUBLIC_OIDC_REDIRECT_URI;
  if (redirectUri) assertHttpsUrl("NEXT_PUBLIC_OIDC_REDIRECT_URI", redirectUri, environment.NODE_ENV);
  return { authority: authority.replace(/\/$/, ""), clientId, redirectUri, scope: environment.NEXT_PUBLIC_OIDC_SCOPE ?? "openid profile email" };
}

function assertHttpsUrl(name: string, value: string, nodeEnv: string | undefined): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${name} must be a URL`); }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(nodeEnv !== "production" && local && url.protocol === "http:")) {
    throw new Error(`${name} must use HTTPS outside local development`);
  }
}
