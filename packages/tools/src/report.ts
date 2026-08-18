import { ClaimSchema, EvidenceItemSchema, ReportCitationSchema } from "@research/contracts";
import { CitationReportComposer } from "@research/reports";
import { z } from "zod";
import { toolFailure } from "./results.js";
import type { Tool } from "./types.js";

const ReportInputSchema = z.object({
  question: z.string().min(1).max(12_000),
  claims: z.array(ClaimSchema).min(1).max(100),
  evidence: z.array(EvidenceItemSchema).min(1).max(500),
});

const ReportOutputSchema = z.object({
  markdown: z.string().min(1),
  citations: z.array(ReportCitationSchema),
  templateVersion: z.literal("citation-report-v1"),
});

export type ReportToolInput = z.input<typeof ReportInputSchema>;
export type ReportToolOutput = z.output<typeof ReportOutputSchema>;

/**
 * A controlled internal renderer, deliberately separate from ReportStore.
 * It cannot create a report from free-form model text: citation validation is
 * performed against the caller's authorized scope before rendering.
 */
export class ReportTool implements Tool<ReportToolInput, ReportToolOutput> {
  readonly manifest = {
    id: "report.compose",
    version: "citation-report-v1",
    capability: "controlled_research_report_rendering",
    requiredEntitlements: [],
    timeoutMs: 5_000,
    enabled: true,
    visibility: "internal" as const,
  };
  readonly input = ReportInputSchema;
  readonly output = ReportOutputSchema;

  constructor(private readonly composer = new CitationReportComposer()) {}

  async invoke(input: ReportToolInput, context: Parameters<Tool<ReportToolInput, ReportToolOutput>["invoke"]>[1]) {
    try {
      const validated = ReportInputSchema.parse(input);
      const document = this.composer.compose({ ...validated, scope: context.scope });
      return {
        ok: true as const,
        value: ReportOutputSchema.parse({ ...document, templateVersion: "citation-report-v1" }),
        evidence: [],
        estimatedCostUsd: 0,
      };
    } catch (error) {
      return toolFailure("INVALID_INPUT", error instanceof Error ? error.message : "report rendering rejected its input");
    }
  }
}
