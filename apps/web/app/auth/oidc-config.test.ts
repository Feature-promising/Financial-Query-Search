import { describe, expect, it } from "vitest";
import { resolveBrowserOidcConfig } from "./oidc-config";

describe("browser OIDC configuration", () => {
  it("accepts public HTTPS metadata and normalizes the issuer slash", () => {
    expect(resolveBrowserOidcConfig({ NODE_ENV: "production", NEXT_PUBLIC_OIDC_AUTHORITY: "https://identity.example/", NEXT_PUBLIC_OIDC_CLIENT_ID: "research-web", NEXT_PUBLIC_OIDC_REDIRECT_URI: "https://research.example/auth/callback" })).toMatchObject({ authority: "https://identity.example", clientId: "research-web" });
  });

  it("rejects partial, non-HTTPS, and production-local configuration", () => {
    expect(() => resolveBrowserOidcConfig({ NEXT_PUBLIC_OIDC_AUTHORITY: "https://identity.example" })).toThrow("configured together");
    expect(() => resolveBrowserOidcConfig({ NODE_ENV: "production", NEXT_PUBLIC_OIDC_AUTHORITY: "http://identity.example", NEXT_PUBLIC_OIDC_CLIENT_ID: "research-web" })).toThrow("must use HTTPS");
    expect(() => resolveBrowserOidcConfig({ NODE_ENV: "production", NEXT_PUBLIC_OIDC_AUTHORITY: "http://localhost:8080", NEXT_PUBLIC_OIDC_CLIENT_ID: "research-web" })).toThrow("must use HTTPS");
  });
});
