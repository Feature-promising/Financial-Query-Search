import { ToolManifestSchema, type ToolManifest } from "@research/contracts";

/**
 * Code-owned identities for every agent-visible production capability.
 * Provider adapters and the API catalog boundary import these definitions so
 * a version, entitlement, or guardrail cannot drift between processes.
 */
export const FilingSearchToolManifest = ToolManifestSchema.parse({
  id: "filing.search", version: "sec-edgar-v1", capability: "sec_filing_retrieval",
  requiredEntitlements: [], timeoutMs: 20_000, enabled: true,
});

export const FinancialDataToolManifest = ToolManifestSchema.parse({
  id: "financial.get", version: "warehouse-v1", capability: "licensed_financial_data",
  requiredEntitlements: ["market-data"], timeoutMs: 20_000, enabled: true,
});

export const RetrievalSearchToolManifest = ToolManifestSchema.parse({
  id: "retrieval.search", version: "hybrid-v1", capability: "hybrid_retrieval",
  requiredEntitlements: [], timeoutMs: 20_000, enabled: true,
});

export const GraphQueryToolManifest = ToolManifestSchema.parse({
  id: "graph.query", version: "graph-v1", capability: "knowledge_graph_read",
  requiredEntitlements: ["graph-read"], timeoutMs: 10_000, enabled: true,
});

export const AnalysisDcfToolManifest = ToolManifestSchema.parse({
  id: "analysis.dcf", version: "dcf-v1", capability: "deterministic_valuation",
  requiredEntitlements: [], timeoutMs: 5_000, enabled: true,
});

const trustedAgentManifests = [
  FilingSearchToolManifest,
  FinancialDataToolManifest,
  RetrievalSearchToolManifest,
  GraphQueryToolManifest,
  AnalysisDcfToolManifest,
] as const;

/** Returns detached manifests so callers cannot mutate the trusted inventory. */
export function listTrustedAgentToolManifests(): ToolManifest[] {
  return trustedAgentManifests.map((manifest) => ({ ...manifest, requiredEntitlements: [...manifest.requiredEntitlements] }));
}
