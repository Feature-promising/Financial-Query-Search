import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, type KeyLike } from "jose";
import { AuthenticationError, OidcTokenVerifier } from "../src/index.js";

const issuer = "https://identity.example.test";
const audience = "interactive-research-agent";
let privateKey: KeyLike;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = "test-key";
  keyResolver = createLocalJWKSet({ keys: [publicJwk] });
});

describe("OidcTokenVerifier", () => {
  it("maps only validated token claims into a tenant-scoped research scope", async () => {
    const verifier = new OidcTokenVerifier({
      issuer,
      audience,
      organizationClaim: "tenant",
      rolesClaim: "groups",
      entitlementsClaim: "grants",
      keyResolver,
    });
    const token = await issue({ tenant: "org-1", groups: ["researcher", "untrusted-role"], grants: "market-data graph-read", email: "analyst@example.test" });

    await expect(verifier.verifyAuthorizationHeader(`Bearer ${token}`)).resolves.toEqual({
      organizationId: "org-1",
      userId: "user-1",
      email: "analyst@example.test",
      roles: ["researcher"],
      entitlements: ["market-data", "graph-read"],
    });
  });

  it("fails closed for a missing bearer token, incompatible issuer/audience, or required identity claim", async () => {
    const verifier = new OidcTokenVerifier({ issuer, audience, keyResolver });
    await expect(verifier.verifyAuthorizationHeader()).rejects.toBeInstanceOf(AuthenticationError);
    await expect(verifier.verifyAuthorizationHeader(`Bearer ${await issue({}, "https://other-issuer.example.test")}`)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(verifier.verifyAuthorizationHeader(`Bearer ${await issue({}, issuer, "other-audience")}`)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(verifier.verifyAuthorizationHeader(`Bearer ${await issue({ organization_id: undefined })}`)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("refuses a token that has no recognized research role", async () => {
    const verifier = new OidcTokenVerifier({ issuer, audience, keyResolver });
    await expect(verifier.verifyAuthorizationHeader(`Bearer ${await issue({ roles: ["guest"] })}`)).rejects.toBeInstanceOf(AuthenticationError);
  });
});

async function issue(overrides: Record<string, unknown>, tokenIssuer = issuer, tokenAudience = audience): Promise<string> {
  const payload = { organization_id: "org-1", roles: ["researcher"], entitlements: ["market-data"], ...overrides };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("user-1")
    .setIssuer(tokenIssuer)
    .setAudience(tokenAudience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}
