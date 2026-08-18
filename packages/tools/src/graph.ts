import { z } from "zod";
import type { KnowledgeGraph } from "@research/knowledge";
import { toolFailure } from "./results.js";
import { GraphQueryToolManifest } from "./manifests.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const GraphInputSchema = z.object({ query: z.string().min(1).max(4_000), limit: z.number().int().min(1).max(50).optional() });
const GraphOutputSchema = z.object({ entity: z.string(), relations: z.array(z.object({ subject: z.string(), predicate: z.string(), object: z.string(), evidenceIds: z.array(z.string()) })) });

/** Read-only graph discovery. Relations are leads only and intentionally do not become citable evidence. */
export class GraphTool implements Tool<z.infer<typeof GraphInputSchema>, z.infer<typeof GraphOutputSchema>> {
  readonly manifest = GraphQueryToolManifest;
  readonly input = GraphInputSchema;
  readonly output = GraphOutputSchema;

  constructor(private readonly graph: KnowledgeGraph) {}

  async invoke(input: z.infer<typeof GraphInputSchema>, context: ToolContext): Promise<ToolResult<z.infer<typeof GraphOutputSchema>>> {
    if (!context.scope.entitlements.includes("graph-read")) return toolFailure("UNAUTHORIZED", "missing entitlement for graph.query");
    const entity = input.query.match(/\b[A-Z]{1,5}\b/)?.[0];
    if (!entity) return toolFailure("INVALID_INPUT", "graph query requires a US ticker symbol");
    const relations = await this.graph.expand(context.scope.organizationId, entity, context.scope.entitlements, input.limit ?? 20);
    return { ok: true, value: { entity, relations }, evidence: [], estimatedCostUsd: 0 };
  }
}
