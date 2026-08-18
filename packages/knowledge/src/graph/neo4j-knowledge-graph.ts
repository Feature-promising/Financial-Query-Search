import { EvidenceGraphRelationSchema } from "@research/contracts";
import type { KnowledgeGraph, KnowledgeGraphWriter } from "../types.js";

export interface CypherReadClient {
  query(statement: string, parameters: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
}

/** Fixed Cypher shapes. Agent-generated Cypher is never accepted. */
export class Neo4jKnowledgeGraph implements KnowledgeGraph, KnowledgeGraphWriter {
  constructor(private readonly client: CypherReadClient) {}

  async expand(tenantId: string, entity: string, allowedEntitlements: string[], limit: number): Promise<Array<{ subject: string; predicate: string; object: string; evidenceIds: string[] }>> {
    const rows = await this.client.query(
      `MATCH (subject:Entity {tenantId: $tenantId, canonicalName: $entity})-[relation]->(object:Entity {tenantId: $tenantId})
       WHERE relation.evidenceId =~ $evidenceIdPattern
         AND (coalesce(relation.requiredEntitlementCount, -1) = 0
          OR (coalesce(relation.requiredEntitlementCount, -1) > 0
              AND all(entitlement IN coalesce(relation.requiredEntitlements, []) WHERE entitlement IN $allowedEntitlements)))
       RETURN subject.canonicalName AS subject, coalesce(relation.predicate, type(relation)) AS predicate, object.canonicalName AS object, [relation.evidenceId] AS evidenceIds
       LIMIT $limit`,
      { tenantId, entity, evidenceIdPattern: UUID_PATTERN, allowedEntitlements: [...new Set(allowedEntitlements)].slice(0, 20), limit: Math.max(1, Math.min(limit, 100)) },
    );
    return rows.flatMap((row) => typeof row.subject === "string" && typeof row.predicate === "string" && typeof row.object === "string"
      ? [{ subject: row.subject, predicate: row.predicate, object: row.object, evidenceIds: Array.isArray(row.evidenceIds) ? row.evidenceIds.filter((id): id is string => typeof id === "string" && UUID_REGEX.test(id)) : [] }]
      : []);
  }

  async deleteEvidenceReferences(tenantId: string, evidenceIds: string[]): Promise<void> {
    if (!evidenceIds.length) return;
    await this.client.query(
      `MATCH ()-[relation]->() WHERE relation.tenantId = $tenantId AND relation.evidenceId IN $evidenceIds
       DELETE relation`,
      { tenantId, evidenceIds: evidenceIds.slice(0, 1_000) },
    );
    // Legacy aggregate edges are retained only while another cited source
    // remains. They have no entitlement-count marker and therefore fail closed
    // at read time until a controlled migration rewrites them.
    await this.client.query(
      `MATCH ()-[relation]->() WHERE relation.tenantId = $tenantId AND relation.evidenceId IS NULL
       SET relation.evidenceIds = [id IN coalesce(relation.evidenceIds, []) WHERE NOT id IN $evidenceIds]`,
      { tenantId, evidenceIds: evidenceIds.slice(0, 1_000) },
    );
    // A relationship without source evidence must not remain available as a
    // graph lead after evidence retention/deletion has completed.
    await this.client.query(
      `MATCH ()-[relation]->() WHERE relation.tenantId = $tenantId AND relation.evidenceId IS NULL AND size(coalesce(relation.evidenceIds, [])) = 0
       DELETE relation`,
      { tenantId },
    );
  }

  async upsertEvidenceRelations(tenantId: string, relations: Array<{ subject: string; predicate: string; object: string; evidenceId: string; requiredEntitlements: string[] }>): Promise<void> {
    if (!relations.length) return;
    if (relations.length > 10_000) throw new Error("too many source-bound graph relations");
    const validated = relations.map((relation) => ({
      ...EvidenceGraphRelationSchema.parse(relation),
      evidenceId: requireEvidenceUuid(relation.evidenceId),
      requiredEntitlements: requireEntitlements(relation.requiredEntitlements),
    }));
    await this.client.query(
      `UNWIND $relations AS input
       MERGE (subject:Entity {tenantId: $tenantId, canonicalName: input.subject})
       MERGE (object:Entity {tenantId: $tenantId, canonicalName: input.object})
       MERGE (subject)-[relation:RELATION {tenantId: $tenantId, predicate: input.predicate, evidenceId: input.evidenceId}]->(object)
       SET relation.requiredEntitlements = input.requiredEntitlements,
           relation.requiredEntitlementCount = size(input.requiredEntitlements)`,
      { tenantId, relations: validated },
    );
  }
}

function requireEntitlements(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 20 || values.some((value) => typeof value !== "string" || value.length < 1 || value.length > 100)) {
    throw new Error("graph relation has invalid required entitlements");
  }
  return [...new Set(values)];
}

function requireEvidenceUuid(value: string): string {
  // Evidence IDs are generated and validated by the shared contracts package.
  // Recheck at this external-write boundary to prevent bypassing ingestion.
  if (!UUID_REGEX.test(value)) {
    throw new Error("graph relation requires a valid evidence UUID");
  }
  return value;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const UUID_REGEX = new RegExp(UUID_PATTERN);
