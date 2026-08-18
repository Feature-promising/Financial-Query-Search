import { EvidenceItemSchema, isClaimEvidenceEligible, isEvidenceAuthorized, type EvidenceItem, type ResearchScope } from "@research/contracts";

/**
 * Authorization boundary for evidence delivery.  Search indexes are not used
 * directly by the API because they are optimized for retrieval, not for a
 * point-in-time, tenant-scoped audit lookup.
 */
export interface EvidenceStore {
  save(scope: ResearchScope, runId: string, items: EvidenceItem[]): Promise<void>;
  get(scope: ResearchScope, id: string): Promise<EvidenceItem | undefined>;
}

/** Development implementation; production uses the PostgreSQL adapter. */
export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly records = new Map<string, EvidenceItem>();

  async save(scope: ResearchScope, _runId: string, items: EvidenceItem[]): Promise<void> {
    for (const candidate of items) {
      const item = EvidenceItemSchema.parse(candidate);
      if (item.tenantId !== scope.organizationId) throw new Error("evidence tenant does not match run scope");
      if (!isClaimEvidenceEligible(item)) throw new Error("research-memory and graph leads must not be stored as run evidence");
      this.records.set(this.key(scope.organizationId, item.id), item);
    }
  }

  async get(scope: ResearchScope, id: string): Promise<EvidenceItem | undefined> {
    const item = this.records.get(this.key(scope.organizationId, id));
    return item && isEvidenceAuthorized(scope, item) ? item : undefined;
  }

  private key(tenantId: string, id: string): string { return `${tenantId}:${id}`; }
}
