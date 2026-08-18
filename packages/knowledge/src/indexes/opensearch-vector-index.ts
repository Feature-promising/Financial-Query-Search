import { EvidenceItemSchema, effectiveEvidenceEntitlements, isClaimEvidenceEligible, requiredEvidenceEntitlements, type EvidenceItem } from "@research/contracts";
import type { RetrievalQuery, VectorIndex } from "../types.js";

export interface OpenSearchTransport {
  bulk(request: { operations: unknown[] }): Promise<OpenSearchBulkResponse>;
  search(request: { index: string; body: Record<string, unknown> }): Promise<{ hits?: { hits?: Array<{ _source?: unknown }> } }>;
  deleteByQuery(request: { index: string; body: Record<string, unknown> }): Promise<unknown>;
}

/** OpenSearch may return HTTP 200 while individual bulk operations fail. */
export interface OpenSearchBulkResponse {
  errors?: boolean;
  items?: Array<Record<string, { status?: number; error?: unknown }>>;
}

export interface EmbeddingRequestOptions { signal?: AbortSignal; }
export interface EmbeddingModel { embed(text: string, options?: EmbeddingRequestOptions): Promise<number[]>; }

/**
 * OpenSearch hybrid index adapter. The supplied transport owns AWS SigV4 or
 * service authentication; this class owns mandatory tenant/query filters.
 */
export class OpenSearchVectorIndex implements VectorIndex {
  constructor(private readonly transport: OpenSearchTransport, private readonly index: string, private readonly embedding: EmbeddingModel) {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(index)) throw new Error("invalid OpenSearch index name");
  }

  async upsert(items: EvidenceItem[]): Promise<void> {
    if (!items.length) return;
    const documents = await Promise.all(items.map(async (item) => {
      const validated = EvidenceItemSchema.parse(item);
      assertExplicitEntitlements(validated);
      const embedding = await this.embedding.embed(validated.content);
      if (!embedding.length || embedding.some((value) => !Number.isFinite(value))) throw new Error("embedding model returned an invalid vector");
      return { validated, embedding };
    }));
    const operations = documents.flatMap(({ validated, embedding }) => [
      { index: { _index: this.index, _id: validated.id } },
      { ...validated, requiredEntitlementCount: requiredEvidenceEntitlements(validated).length, embedding },
    ]);
    const response = await this.transport.bulk({ operations });
    if (!response.items || response.items.length !== documents.length || response.errors || response.items.some((item) => Object.values(item).some((operation) => operation.error || (operation.status != null && operation.status >= 300)))) {
      throw new Error("OpenSearch bulk indexing reported one or more failed evidence operations");
    }
  }

  async search(query: RetrievalQuery, options: EmbeddingRequestOptions = {}): Promise<EvidenceItem[]> {
    const filters: Record<string, unknown>[] = [{ term: { tenantId: query.tenantId } }, evidenceEntitlementFilter(query.allowedEntitlements)];
    if (query.sourceTypes?.length) filters.push({ terms: { sourceType: query.sourceTypes } });
    if (query.entities?.length) filters.push({ terms: { entity: query.entities } });
    if (query.asOfDate) filters.push({ range: { asOfDate: { lte: query.asOfDate } } });
    const vector = await this.embedding.embed(query.text, options);
    if (!vector.length || vector.some((value) => !Number.isFinite(value))) throw new Error("embedding model returned an invalid vector");
    const response = await this.transport.search({
      index: this.index,
      body: {
        size: Math.max(1, Math.min(query.limit, 100)),
        query: {
          bool: {
            filter: filters,
            should: [
              { multi_match: { query: query.text, fields: ["title^3", "content", "entity^2"], type: "best_fields" } },
              { knn: { embedding: { vector, k: Math.max(1, Math.min(query.limit, 100)) } } },
            ],
            minimum_should_match: 1,
          },
        },
      },
    });
    return (response.hits?.hits ?? []).flatMap((hit) => {
      const parsed = EvidenceItemSchema.safeParse(hit._source);
      // OpenSearch query filters are necessary but not sufficient: aliases,
      // mapping drift, or a faulty transport must not bypass this adapter's
      // tenant and licence boundary.
      return parsed.success && isResultAuthorized(parsed.data, query) ? [parsed.data] : [];
    });
  }

  async deleteByEvidenceIds(tenantId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.transport.deleteByQuery({
      index: this.index,
      body: { query: { bool: { filter: [{ term: { tenantId } }, { terms: { id: ids.slice(0, 1_000) } }] } } },
    });
  }
}

/**
 * A terms_set query permits a document only when every required entitlement is
 * in the authenticated caller's allow-list. Documents without requirements are
 * tenant-public and remain retrievable for callers with no data grants.
 */
function evidenceEntitlementFilter(allowedEntitlements: string[]): Record<string, unknown> {
  const publicWithinTenant = { bool: { filter: [{ term: { authority: "primary" } }], must_not: [{ exists: { field: "requiredEntitlements" } }] } };
  if (!allowedEntitlements.length) return publicWithinTenant;
  return {
    bool: {
      should: [
        publicWithinTenant,
        { terms_set: { requiredEntitlements: { terms: allowedEntitlements, minimum_should_match_field: "requiredEntitlementCount" } } },
      ],
      minimum_should_match: 1,
    },
  };
}

function assertExplicitEntitlements(item: EvidenceItem): void {
  if (!isClaimEvidenceEligible(item)) throw new Error("research-memory and graph leads must not be indexed as claim evidence");
  if (item.authority !== "primary" && !item.requiredEntitlements?.length) {
    throw new Error("licensed and secondary evidence must declare required entitlements before indexing");
  }
}

function isResultAuthorized(item: EvidenceItem, query: RetrievalQuery): boolean {
  return item.tenantId === query.tenantId
    && isClaimEvidenceEligible(item)
    && effectiveEvidenceEntitlements(item).every((entitlement) => query.allowedEntitlements.includes(entitlement));
}
