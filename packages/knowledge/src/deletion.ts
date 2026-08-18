import type { EvidenceLake, KnowledgeGraph, VectorIndex } from "./types.js";

export interface EvidenceDeletionRequest {
  tenantId: string;
  evidenceIds: string[];
  evidenceUris: string[];
}

/** Coordinates physical evidence deletion across indexes, graph references and source objects. */
export class EvidenceDeletionCoordinator {
  constructor(private readonly dependencies: { index: VectorIndex; graph: KnowledgeGraph; lake: EvidenceLake }) {}

  async delete(request: EvidenceDeletionRequest): Promise<void> {
    const evidenceIds = [...new Set(request.evidenceIds)].slice(0, 1_000);
    const evidenceUris = [...new Set(request.evidenceUris)].slice(0, 1_000);
    const operations: Promise<unknown>[] = [];
    if (evidenceIds.length) {
      operations.push(this.dependencies.index.deleteByEvidenceIds(request.tenantId, evidenceIds));
      operations.push(this.dependencies.graph.deleteEvidenceReferences(request.tenantId, evidenceIds));
    }
    operations.push(...evidenceUris.map((uri) => this.dependencies.lake.delete(uri)));
    const results = await Promise.allSettled(operations);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "evidence deletion propagation failed");
  }
}
