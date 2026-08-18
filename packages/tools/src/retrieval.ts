import { z } from "zod";
import { ResearchMemoryHintSchema } from "@research/contracts";
import type { HybridRetrievalPipeline } from "@research/knowledge";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { RetrievalSearchToolManifest } from "./manifests.js";

const RetrievalInputSchema = z.object({
  query: z.string().min(1).max(4_000),
  entities: z.array(z.string().min(1).max(100)).max(10).optional(),
  sourceTypes: z.array(z.enum(["sec_filing", "company_ir", "market_data", "news", "research_memory", "graph"])).optional(),
  asOfDate: z.string().date().optional(),
  researchMemorySeeds: z.array(ResearchMemoryHintSchema).max(4).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
const RetrievalOutputSchema = z.object({ expandedQueries: z.array(z.string()), evidenceCount: z.number().int().nonnegative() });

/** Permission-filtered RAG retrieval; it exposes only server-assigned evidence IDs to the model. */
export class HybridRetrievalTool implements Tool<z.infer<typeof RetrievalInputSchema>, z.infer<typeof RetrievalOutputSchema>> {
  readonly manifest = RetrievalSearchToolManifest;
  readonly input = RetrievalInputSchema;
  readonly output = RetrievalOutputSchema;

  constructor(private readonly pipeline: HybridRetrievalPipeline) {}

  async invoke(input: z.infer<typeof RetrievalInputSchema>, context: ToolContext): Promise<ToolResult<z.infer<typeof RetrievalOutputSchema>>> {
    const result = await this.pipeline.retrieve(context.scope, { text: input.query, entities: input.entities, sourceTypes: input.sourceTypes, asOfDate: input.asOfDate, researchMemorySeeds: input.researchMemorySeeds, limit: input.limit ?? 12 }, 8_000, { signal: context.signal });
    return { ok: true, value: { expandedQueries: result.expandedQueries, evidenceCount: result.evidence.length }, evidence: result.evidence, estimatedCostUsd: 0 };
  }
}
