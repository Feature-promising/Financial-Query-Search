import type { EvidenceItem, ResearchScope } from "@research/contracts";
import { filterAuthorizedEvidence } from "../context.js";
import type { KnowledgeGraph, RetrievalQuery, VectorIndex } from "../types.js";
import { expandQuery } from "./query-expansion.js";
import { rerankEvidence } from "./reranker.js";

export interface HybridRetrievalResult {
  expandedQueries: string[];
  graphRelations: Array<{ subject: string; predicate: string; object: string; evidenceIds: string[] }>;
  evidence: EvidenceItem[];
}

/**
 * Orchestrates controlled query expansion, permission-scoped index searches,
 * graph discovery, deterministic reranking, and context construction.
 */
export class HybridRetrievalPipeline {
  constructor(private readonly index: VectorIndex, private readonly graph?: KnowledgeGraph) {}

  async retrieve(scope: ResearchScope, request: Omit<RetrievalQuery, "tenantId" | "allowedEntitlements">, tokenBudget = 8_000, options: { signal?: AbortSignal } = {}): Promise<HybridRetrievalResult> {
    const query: RetrievalQuery = { ...request, tenantId: scope.organizationId, allowedEntitlements: [...scope.entitlements], limit: Math.max(1, Math.min(request.limit, 100)) };
    const expandedQueries = expandQuery(query);
    const graphRelations = await this.expandGraph(query);
    const graphTerms = graphRelations.flatMap((relation) => [relation.subject, relation.object]).filter((value) => value.length <= 100);
    const researchMemoryQueries = (query.researchMemorySeeds ?? []).slice(0, 4).map((seed) => seed.question);
    const searches = [...new Set([...expandedQueries, ...researchMemoryQueries, ...graphTerms.map((term) => `${query.text} ${term}`)])].slice(0, 16);
    const responses = await Promise.all(searches.map((text) => this.index.search({ ...query, text }, options)));
    const candidates = deduplicateEvidence(responses.flat());
    const ranked = rerankEvidence({ text: query.text, asOfDate: query.asOfDate }, candidates, query.limit);
    return { expandedQueries, graphRelations, evidence: filterAuthorizedEvidence(scope, ranked, tokenBudget) };
  }

  private async expandGraph(query: RetrievalQuery): Promise<HybridRetrievalResult["graphRelations"]> {
    // Graph traversal can disclose relationship leads even when no graph
    // passage reaches the model. Keep it behind the same explicit capability
    // grant enforced by GraphTool rather than treating it as a free query
    // expansion side effect.
    if (!this.graph || !query.entities?.length || !query.allowedEntitlements.includes("graph-read")) return [];
    const responses = await Promise.all(query.entities.slice(0, 10).map((entity) => this.graph!.expand(query.tenantId, entity, query.allowedEntitlements, 20)));
    return responses.flat();
  }
}

function deduplicateEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const evidence = new Map<string, EvidenceItem>();
  for (const item of items) evidence.set(item.id, item);
  return [...evidence.values()];
}
