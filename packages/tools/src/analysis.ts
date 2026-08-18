import { z } from "zod";
import { effectiveEvidenceEntitlements, type EvidenceItem } from "@research/contracts";
import type { Tool } from "./types.js";
import { toolFailure } from "./results.js";
import { AnalysisDcfToolManifest } from "./manifests.js";

const DcfAssumptionsSchema = z.object({
  ticker: z.string().regex(/^[A-Z.]{1,10}$/),
  freeCashFlow: z.number().finite(),
  growthRate: z.number().min(-0.99).max(1),
  terminalGrowthRate: z.number().min(-0.99).max(0.1),
  discountRate: z.number().min(0.001).max(1),
  years: z.number().int().min(1).max(20),
  fiscalPeriod: z.string().min(1),
  asOfDate: z.string().date(),
  sourceEvidenceIds: z.array(z.string().uuid()).min(1).max(1),
});
export const DcfInputSchema = DcfAssumptionsSchema;
const DcfOutputSchema = z.object({
  enterpriseValue: z.number().finite(),
  formulaVersion: z.literal("dcf-v1"),
  assumptions: DcfAssumptionsSchema,
});

const valuationRecordSchema = z.object({
  ticker: z.string().regex(/^[A-Z.]{1,10}$/),
  fiscal_period: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  unit: z.string().min(1).max(64),
  free_cash_flow: z.coerce.number().finite(),
  fcf_growth_rate: z.coerce.number().min(-0.99).max(1),
  terminal_growth_rate: z.coerce.number().min(-0.99).max(0.1),
  discount_rate: z.coerce.number().min(0.001).max(1),
  projection_years: z.coerce.number().int().min(1).max(20),
  source_as_of: z.string().date(),
});

/**
 * Converts exactly one licensed valuation-input record into DCF assumptions.
 * The LLM never supplies these numbers: all fields are source-bound to the
 * evidence produced by the fixed warehouse template in this same run.
 */
export function dcfInputFromEvidence(evidence: EvidenceItem[], ticker: string): z.infer<typeof DcfInputSchema> | undefined {
  const matches = evidence.filter((item) => item.sourceType === "market_data"
    && item.authority === "licensed"
    && item.entity === ticker
    && item.metadata.template === "valuation_inputs"
    && effectiveEvidenceEntitlements(item).includes("market-data"));
  if (matches.length !== 1) return undefined;
  const source = matches[0]!;
  let record: z.infer<typeof valuationRecordSchema>;
  try { record = valuationRecordSchema.parse(JSON.parse(source.content)); }
  catch { return undefined; }
  if (record.ticker !== ticker
    || source.asOfDate !== record.source_as_of
    || source.metadata.currency !== record.currency
    || source.metadata.unit !== record.unit
    || source.metadata.fiscalPeriod !== record.fiscal_period
    || record.discount_rate <= record.terminal_growth_rate) return undefined;
  return DcfInputSchema.parse({
    ticker, freeCashFlow: record.free_cash_flow, growthRate: record.fcf_growth_rate,
    terminalGrowthRate: record.terminal_growth_rate, discountRate: record.discount_rate,
    years: record.projection_years, fiscalPeriod: record.fiscal_period,
    asOfDate: record.source_as_of, sourceEvidenceIds: [source.id],
  });
}

export const analysisDcfTool: Tool<z.infer<typeof DcfInputSchema>, z.infer<typeof DcfOutputSchema>> = {
  manifest: AnalysisDcfToolManifest,
  input: DcfInputSchema,
  output: DcfOutputSchema,
  async invoke(input) {
    if (input.discountRate <= input.terminalGrowthRate) return toolFailure("INVALID_INPUT", "discountRate must exceed terminalGrowthRate");
    let presentValue = 0;
    for (let year = 1; year <= input.years; year += 1) {
      const cashFlow = input.freeCashFlow * (1 + input.growthRate) ** year;
      presentValue += cashFlow / (1 + input.discountRate) ** year;
    }
    const terminalCashFlow = input.freeCashFlow * (1 + input.growthRate) ** input.years * (1 + input.terminalGrowthRate);
    const terminalValue = terminalCashFlow / (input.discountRate - input.terminalGrowthRate);
    return { ok: true, value: { enterpriseValue: presentValue + terminalValue / (1 + input.discountRate) ** input.years, formulaVersion: "dcf-v1", assumptions: input }, evidence: [], estimatedCostUsd: 0 };
  },
};
