import { ResearchScopeSchema, type ResearchScope } from "@research/contracts";

export interface SqlClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

/** Resolves a verified OIDC subject to the stable internal user UUID. */
export interface PrincipalProvisioner { resolve(scope: ResearchScope): Promise<ResearchScope>; }

/**
 * Maps trusted OIDC UUID claims to the local tenant/user records required by
 * foreign keys. The IdP remains the authority for authentication and roles.
 */
export class PostgresPrincipalProvisioner implements PrincipalProvisioner {
  constructor(private readonly client: SqlClient) {}

  async resolve(scope: ResearchScope): Promise<ResearchScope> {
    if (!scope.email) throw new Error("OIDC token must include an email claim for principal provisioning");
    await this.client.query(
      `INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [scope.organizationId, scope.organizationId],
    );
    const user = await this.client.query<{ id: string }>(
      `INSERT INTO users (organization_id, oidc_subject, email) VALUES ($1,$2,$3)
       ON CONFLICT (organization_id, oidc_subject) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [scope.organizationId, scope.userId, scope.email],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error("principal provisioning did not return a user id");
    return ResearchScopeSchema.parse({ ...scope, userId });
  }
}
