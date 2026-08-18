import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ResearchScopeSchema, type ResearchScope } from "@research/contracts";
import { AuthenticationError } from "./errors.js";

export interface OidcVerifierOptions {
  issuer: string;
  audience: string;
  organizationClaim?: string;
  rolesClaim?: string;
  entitlementsClaim?: string;
  emailClaim?: string;
  /** Test and trusted-platform adapter seam; production defaults to issuer JWKS. */
  keyResolver?: JWTVerifyGetKey;
}

export class OidcTokenVerifier {
  private readonly keyResolver: JWTVerifyGetKey;
  constructor(private readonly options: OidcVerifierOptions) {
    this.keyResolver = options.keyResolver ?? createRemoteJWKSet(new URL(`${options.issuer.replace(/\/$/, "")}/.well-known/jwks.json`));
  }

  async verifyAuthorizationHeader(header?: string): Promise<ResearchScope> {
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new AuthenticationError();
    try {
      const { payload } = await jwtVerify(token, this.keyResolver, { issuer: this.options.issuer, audience: this.options.audience });
      const organizationId = claimString(payload, this.options.organizationClaim ?? "organization_id");
      const userId = claimString(payload, "sub");
      const roles = claimStrings(payload, this.options.rolesClaim ?? "roles").filter((role): role is "researcher" | "admin" => role === "researcher" || role === "admin");
      if (!organizationId || !userId || roles.length === 0) throw new AuthenticationError();
      return ResearchScopeSchema.parse({ organizationId, userId, email: claimString(payload, this.options.emailClaim ?? "email"), roles, entitlements: claimStrings(payload, this.options.entitlementsClaim ?? "entitlements") });
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError();
    }
  }
}

function claimString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]; return typeof value === "string" && value.length > 0 ? value : undefined;
}
function claimStrings(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key]; return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? value.split(/[ ,]+/).filter(Boolean) : [];
}
