import { analysisDcfTool } from "./analysis.js";
import { disabledResearchTool } from "./disabled.js";
import { ToolRegistry } from "./registry.js";
import { InMemoryToolAuditSink, type Tool, type ToolAuditSink } from "./types.js";
import { SecEdgarClient, SecFilingTool } from "./filings/index.js";
import type { HybridRetrievalPipeline } from "@research/knowledge";
import type { FinancialWarehouse } from "@research/knowledge";
import { FinancialDataTool } from "./financial-data.js";
import type { KnowledgeGraph } from "@research/knowledge";
import { GraphTool } from "./graph.js";
import { HybridRetrievalTool } from "./retrieval.js";
import { ReportTool } from "./report.js";
import { parseApprovedToolManifestCatalog } from "./catalog.js";
import { listTrustedAgentToolManifests } from "./manifests.js";
import { z } from "zod";
import type { ToolManifest } from "@research/contracts";

export interface DefaultToolOptions { audit?: ToolAuditSink; secUserAgent?: string; secMaxResponseBytes?: number; retrievalPipeline?: HybridRetrievalPipeline; financialWarehouse?: FinancialWarehouse; financialLicense?: string; graph?: KnowledgeGraph; approvedManifests?: ToolManifest[]; }

export function createDefaultToolRegistry(options: DefaultToolOptions = {}): ToolRegistry {
  const audit = options.audit ?? new InMemoryToolAuditSink();
  const registry = new ToolRegistry(audit);
  if (options.secUserAgent) registry.register(new SecFilingTool(new SecEdgarClient({ userAgent: options.secUserAgent, maxResponseBytes: options.secMaxResponseBytes })));
  else registry.register(disabledResearchTool("filing.search", "sec_filing_retrieval"));
  if (options.financialWarehouse && options.financialLicense) registry.register(new FinancialDataTool(options.financialWarehouse, options.financialLicense));
  else registry.register(disabledResearchTool("financial.get", "licensed_financial_data"));
  if (options.retrievalPipeline) registry.register(new HybridRetrievalTool(options.retrievalPipeline));
  else registry.register(disabledResearchTool("retrieval.search", "hybrid_retrieval"));
  if (options.graph) registry.register(new GraphTool(options.graph));
  else registry.register(disabledResearchTool("graph.query", "knowledge_graph_read"));
  registry.register(analysisDcfTool);
  // The runtime invokes this after Critic approval. It is deliberately absent
  // from planner allowlists, so an LLM cannot use it to bypass evidence gates.
  registry.register(new ReportTool());
  if (options.approvedManifests) registry.applyApprovedCatalog(options.approvedManifests);
  return registry;
}

/**
 * API submission processes need the exact approved manifests but never invoke
 * providers. These trusted placeholders make catalog validation symmetrical
 * with the Worker while rejecting accidental in-process execution.
 */
export function createSubmissionToolRegistry(approvedManifests: ToolManifest[]): ToolRegistry {
  const registry = new ToolRegistry(new InMemoryToolAuditSink());
  for (const manifest of listTrustedAgentToolManifests()) registry.register(catalogSubmissionTool(manifest));
  registry.applyApprovedCatalog(approvedManifests);
  return registry;
}

function catalogSubmissionTool(manifest: ToolManifest): Tool<unknown, unknown> {
  return {
    manifest,
    input: z.unknown(),
    output: z.never(),
    async invoke() { return { ok: false, failure: { code: "UNAVAILABLE", message: "submission catalog cannot invoke a provider", retryable: false }, estimatedCostUsd: 0 }; },
  };
}

export * from "./analysis.js";
export * from "./catalog.js";
export * from "./disabled.js";
export * from "./filings/index.js";
export * from "./financial-data.js";
export * from "./graph.js";
export * from "./manifests.js";
export * from "./registry.js";
export * from "./reliability.js";
export * from "./results.js";
export * from "./retrieval.js";
export * from "./report.js";
export * from "./postgres-audit.js";
export * from "./types.js";
