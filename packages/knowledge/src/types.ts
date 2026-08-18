import type { EvidenceGraphRelation, EvidenceItem, ResearchMemoryHint } from "@research/contracts";

export interface RetrievalQuery {
  text: string;
  tenantId: string;
  /** Entitlements are injected from the authenticated scope, never agent input. */
  allowedEntitlements: string[];
  entities?: string[];
  sourceTypes?: EvidenceItem["sourceType"][];
  asOfDate?: string;
  /** Metadata-only seeds from prior published research; never evidence itself. */
  researchMemorySeeds?: ResearchMemoryHint[];
  limit: number;
}

export interface VectorIndex {
  upsert(items: EvidenceItem[]): Promise<void>;
  search(query: RetrievalQuery, options?: { signal?: AbortSignal }): Promise<EvidenceItem[]>;
  deleteByEvidenceIds(tenantId: string, ids: string[]): Promise<void>;
}

export interface KnowledgeGraph {
  expand(tenantId: string, entity: string, allowedEntitlements: string[], limit: number): Promise<Array<{ subject: string; predicate: string; object: string; evidenceIds: string[] }>>;
  deleteEvidenceReferences(tenantId: string, evidenceIds: string[]): Promise<void>;
}

/** Write boundary used only by trusted ingestion, never by an Agent tool. */
export interface KnowledgeGraphWriter {
  upsertEvidenceRelations(tenantId: string, relations: Array<EvidenceGraphRelation & { evidenceId: string; requiredEntitlements: string[] }>): Promise<void>;
}

export type FinancialWarehouseTemplate = "company_fundamentals" | "price_history" | "industry_benchmark" | "valuation_inputs";

export interface FinancialWarehouse {
  query(templateId: FinancialWarehouseTemplate, parameters: Record<string, string | number>, signal?: AbortSignal): Promise<Array<Record<string, unknown>>>;
}

export interface EvidenceLake {
  put(key: string, body: Uint8Array, metadata: Record<string, string>): Promise<{ uri: string; versionId: string }>;
  get(uri: string): Promise<Uint8Array>;
  delete(uri: string): Promise<void>;
}

export interface CitationVerification { claimId: string; valid: boolean; reason?: string; }
