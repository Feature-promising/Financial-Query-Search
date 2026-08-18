import { EvidenceItemSchema, isClaimEvidenceEligible, isEvidenceAuthorized, type EvidenceItem, type ResearchScope } from "@research/contracts";

interface SqlClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

type EvidenceRow = Record<string, unknown>;

/** Structural contract shared with the knowledge-layer API boundary. */
export interface EvidenceStore {
  save(scope: ResearchScope, runId: string, items: EvidenceItem[]): Promise<void>;
  get(scope: ResearchScope, id: string): Promise<EvidenceItem | undefined>;
}

/**
 * Stores an immutable evidence record once and records every research run
 * which used it.  A UUID collision across tenants is rejected instead of
 * silently making one tenant's evidence visible to another.
 */
export class PostgresEvidenceStore implements EvidenceStore {
  constructor(private readonly client: SqlClient) {}

  async save(scope: ResearchScope, runId: string, items: EvidenceItem[]): Promise<void> {
    for (const candidate of items) {
      const item = EvidenceItemSchema.parse(candidate);
      if (item.tenantId !== scope.organizationId) throw new Error("evidence tenant does not match run scope");
      if (!isClaimEvidenceEligible(item)) throw new Error("research-memory and graph leads must not be stored as run evidence");
      const metadata = serializeMetadata(item);
      await this.client.query(
        `INSERT INTO evidence_items (id, run_id, organization_id, source_type, authority, source_url, locator, content_hash, content, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [item.id, runId, scope.organizationId, item.sourceType, item.authority, item.sourceUrl, item.locator, item.contentHash, item.content, metadata],
      );
      const owner = await this.client.query<{ organization_id: string }>("SELECT organization_id FROM evidence_items WHERE id=$1", [item.id]);
      if (owner.rows[0]?.organization_id !== scope.organizationId) throw new Error("evidence identifier belongs to another tenant");
      await this.client.query(
        "INSERT INTO research_run_evidence (run_id, evidence_id, organization_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [runId, item.id, scope.organizationId],
      );
    }
  }

  async get(scope: ResearchScope, id: string): Promise<EvidenceItem | undefined> {
    const result = await this.client.query<EvidenceRow>(
      "SELECT * FROM evidence_items WHERE id=$1 AND organization_id=$2",
      [id, scope.organizationId],
    );
    const item = result.rows[0] ? toEvidence(result.rows[0]) : undefined;
    return item && isEvidenceAuthorized(scope, item) ? item : undefined;
  }
}

function serializeMetadata(item: EvidenceItem): Record<string, unknown> {
  return {
    ...item.metadata,
    title: item.title,
    entity: item.entity,
    publishedAt: item.publishedAt,
    asOfDate: item.asOfDate,
    retrievedAt: item.retrievedAt,
    license: item.license,
    requiredEntitlements: item.requiredEntitlements ?? [],
  };
}

function toEvidence(row: EvidenceRow): EvidenceItem {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return EvidenceItemSchema.parse({
    id: row.id,
    sourceType: row.source_type,
    authority: row.authority,
    title: metadata.title,
    content: row.content,
    sourceUrl: row.source_url,
    locator: row.locator,
    entity: metadata.entity ?? null,
    publishedAt: metadata.publishedAt ?? null,
    asOfDate: metadata.asOfDate ?? null,
    retrievedAt: metadata.retrievedAt,
    contentHash: row.content_hash,
    license: metadata.license,
    requiredEntitlements: metadata.requiredEntitlements,
    tenantId: row.organization_id,
    metadata: stripStoredFields(metadata),
  });
}

function stripStoredFields(metadata: Record<string, unknown>): Record<string, unknown> {
  const { title: _title, entity: _entity, publishedAt: _publishedAt, asOfDate: _asOfDate, retrievedAt: _retrievedAt, license: _license, requiredEntitlements: _requiredEntitlements, ...rest } = metadata;
  return rest;
}
