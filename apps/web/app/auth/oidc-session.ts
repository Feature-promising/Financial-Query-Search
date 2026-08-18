"use client";

import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { resolveBrowserOidcConfig } from "./oidc-config";

const returnToKey = "research.return-to";
let manager: UserManager | undefined;

export interface OidcSessionState {
  enabled: boolean;
  authenticated: boolean;
}

/** Browser-only authorization-code + PKCE client. No client secret is exposed. */
export function oidcEnabled(): boolean {
  return Boolean(resolveBrowserOidcConfig());
}

export async function getOidcSessionState(): Promise<OidcSessionState> {
  if (!oidcEnabled()) return { enabled: false, authenticated: false };
  const user = await getManager().getUser();
  return { enabled: true, authenticated: Boolean(user && !user.expired && user.access_token) };
}

/** Returns a current access token, or starts an interactive login redirect. */
export async function getAccessTokenOrRedirect(returnTo: string): Promise<string | undefined> {
  if (!oidcEnabled()) {
    if (process.env.NODE_ENV === "production") throw new Error("browser OIDC must be configured for production research requests");
    return undefined;
  }
  const user = await getManager().getUser();
  if (user && !user.expired && user.access_token) return user.access_token;
  window.sessionStorage.setItem(returnToKey, safeReturnTo(returnTo));
  await getManager().signinRedirect();
  return undefined;
}

export async function completeSignIn(): Promise<string> {
  const user = await getManager().signinRedirectCallback();
  if (!user.access_token || user.expired) throw new Error("OIDC callback did not provide a valid access token");
  const returnTo = safeReturnTo(window.sessionStorage.getItem(returnToKey) ?? "/");
  window.sessionStorage.removeItem(returnToKey);
  return returnTo;
}

export async function startSignIn(returnTo = window.location.pathname): Promise<void> {
  if (!oidcEnabled()) throw new Error("browser OIDC is not configured");
  window.sessionStorage.setItem(returnToKey, safeReturnTo(returnTo));
  await getManager().signinRedirect();
}

export async function signOut(): Promise<void> {
  if (!oidcEnabled()) return;
  await getManager().signoutRedirect();
}

function getManager(): UserManager {
  if (manager) return manager;
  const config = resolveBrowserOidcConfig();
  if (!config) throw new Error("browser OIDC is not configured");
  manager = new UserManager({
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: config.redirectUri ?? `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: window.location.origin,
    response_type: "code",
    scope: config.scope,
    // Tokens and authorization state disappear when the browser session closes.
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: false,
  });
  return manager;
}

function safeReturnTo(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}
