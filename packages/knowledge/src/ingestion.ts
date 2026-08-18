import { EvidenceItemSchema, isClaimEvidenceEligible, type EvidenceItem } from "@research/contracts";
import type { EvidenceLake, KnowledgeGraphWriter, VectorIndex } from "./types.js";

export interface EvidenceRepository { store(items: EvidenceItem[]): Promise<EvidenceItem[]>; }

/** Persists immutable evidence content before adding it to the retrieval index. */
export class EvidenceIngestionService implements EvidenceRepository {
  constructor(private readonly lake: EvidenceLake, private readonly index: VectorIndex, private readonly graph?: KnowledgeGraphWriter) {}

  async store(items: EvidenceItem[]): Promise<EvidenceItem[]> {
    return Promise.all(items.map((candidate) => this.storeOne(candidate)));
  }

  private async storeOne(candidate: EvidenceItem): Promise<EvidenceItem> {
    // Validate at the first persistence boundary. This prevents an invalid
    // or lead-only record from being retained in S3 when indexing later
    // rejects it, and keeps lake/index/graph eligibility consistent.
    const item = assertIndexableEvidence(EvidenceItemSchema.parse(candidate));
    const object = await this.lake.put(`${item.tenantId}/${item.contentHash}.txt`, new TextEncoder().encode(item.content), {
      "content-hash": item.contentHash, "source-type": item.sourceType, "evidence-id": item.id,
    });
    const persisted = { ...item, metadata: { ...item.metadata, evidenceUri: object.uri, evidenceVersionId: object.versionId } };
    try {
      await this.index.upsert([persisted]);
    } catch (error) {
      await compensateFailedIndexWrite(this.lake, this.index, item.tenantId, item.id, object.uri, error);
    }

    // Graph edges are derived search leads, never the source of a claim. Do
    // not compensate by deleting source evidence after a graph outage: that
    // would trade a recoverable derived-index gap for irreversible evidence
    // loss. Propagate the error so the scheduled ingestion can retry safely.
    const relations = persisted.graphRelations?.map((relation) => ({ ...relation, evidenceId: persisted.id, requiredEntitlements: persisted.requiredEntitlements ?? [] })) ?? [];
    if (relations.length) await this.graph?.upsertEvidenceRelations(persisted.tenantId, relations);
    return persisted;
  }
}

function assertIndexableEvidence(item: EvidenceItem): EvidenceItem {
  if (!isClaimEvidenceEligible(item)) throw new Error("research-memory and graph leads must not be ingested as claim evidence");
  if (item.authority !== "primary" && !item.requiredEntitlements?.length) {
    throw new Error("licensed and secondary evidence must declare required entitlements before ingestion");
  }
  return item;
}

/**
 * OpenSearch bulk writes can partially succeed before reporting an error.
 * Remove both representations so an error never leaves retrievable evidence
 * whose source-lake write was compensated. A retry can safely rebuild the
 * complete immutable item from the ingestion source.
 */
async function compensateFailedIndexWrite(lake: EvidenceLake, index: VectorIndex, tenantId: string, evidenceId: string, uri: string, indexingError: unknown): Promise<never> {
  const cleanupErrors: unknown[] = [];
  try {
    await index.deleteByEvidenceIds(tenantId, [evidenceId]);
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  try {
    await lake.delete(uri);
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  if (cleanupErrors.length) throw new AggregateError([indexingError, ...cleanupErrors], "evidence indexing failed and cross-store compensation also failed");
  throw indexingError;
}
