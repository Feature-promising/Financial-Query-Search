import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FinancialWarehouse } from "@research/knowledge";
import type { EvidenceItem } from "@research/contracts";
import { toolFailure } from "./results.js";
import { FinancialDataToolManifest } from "./manifests.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const FinancialInputSchema = z.object({
  query: z.string().min(1).max(4_000),
  template: z.enum(["company_fundamentals", "price_history", "industry_benchmark", "valuation_inputs"]).optional(),
  asOfDate: z.string().date().optional(),
});
const FinancialOutputSchema = z.object({ ticker: z.string(), template: z.enum(["company_fundamentals", "price_history", "industry_benchmark", "valuation_inputs"]), recordCount: z.number().int().nonnegative() });
const sourceBoundRecordSchema = z.object({
  ticker: z.string().regex(/^[A-Z.]{1,10}$/),
  source_as_of: z.string().date(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  unit: z.string().min(1).max(64),
}).passthrough();
const fiscalRecordSchema = sourceBoundRecordSchema.extend({ fiscal_period: z.string().min(1).max(40) });
const priceRecordSchema = sourceBoundRecordSchema.extend({ trade_date: z.string().date() });

/** Whitelisted financial warehouse templates; agents never generate SQL. */
export class FinancialDataTool implements Tool<z.infer<typeof FinancialInputSchema>, z.infer<typeof FinancialOutputSchema>> {
  readonly manifest = FinancialDataToolManifest;
  readonly input = FinancialInputSchema;
  readonly output = FinancialOutputSchema;

  constructor(private readonly warehouse: FinancialWarehouse, private readonly license: string) {}

  async invoke(input: z.infer<typeof FinancialInputSchema>, context: ToolContext): Promise<ToolResult<z.infer<typeof FinancialOutputSchema>>> {
    if (!context.scope.entitlements.includes("market-data")) return toolFailure("UNAUTHORIZED", "missing entitlement for financial.get");
    const ticker = tickerFromQuery(input.query);
    if (!ticker) return toolFailure("INVALID_INPUT", "financial data query requires a US ticker symbol");
    const template = input.template ?? "company_fundamentals";
    const parameters: Record<string, string> = { ticker, asOfDate: input.asOfDate ?? "9999-12-31" };
    const records = await this.warehouse.query(template, parameters, context.signal);
    const validated = validateFinancialRecords(records, ticker, template);
    if (!validated.ok) return toolFailure("INVALID_INPUT", validated.message);
    return {
      ok: true,
      value: { ticker, template, recordCount: records.length },
      evidence: validated.records.map((record, index) => this.toEvidence(record, ticker, template, context, index)),
      estimatedCostUsd: 0,
    };
  }

  private toEvidence(record: SourceBoundFinancialRecord, ticker: string, template: z.infer<typeof FinancialInputSchema>["template"], context: ToolContext, index: number): EvidenceItem {
    const content = JSON.stringify(record);
    const fiscalPeriod = typeof record.fiscal_period === "string" ? record.fiscal_period : undefined;
    return {
      id: randomUUID(), sourceType: "market_data", authority: "licensed", title: `${ticker} ${template} record ${index + 1}`,
      content, sourceUrl: null, locator: `warehouse:${template}; row:${index + 1}`, entity: ticker, publishedAt: null, asOfDate: record.source_as_of,
      retrievedAt: new Date().toISOString(), contentHash: createHash("sha256").update(content).digest("hex"), license: this.license, tenantId: context.scope.organizationId,
      requiredEntitlements: ["market-data"],
      metadata: { template, fields: Object.keys(record).sort(), sourceAsOf: record.source_as_of, currency: record.currency, unit: record.unit, ...(fiscalPeriod ? { fiscalPeriod } : {}) },
    };
  }
}

type SourceBoundFinancialRecord = z.infer<typeof sourceBoundRecordSchema>;

function validateFinancialRecords(records: Array<Record<string, unknown>>, ticker: string, template: z.infer<typeof FinancialInputSchema>["template"]): { ok: true; records: SourceBoundFinancialRecord[] } | { ok: false; message: string } {
  const schema = template === "price_history" ? priceRecordSchema : fiscalRecordSchema;
  const validated: SourceBoundFinancialRecord[] = [];
  for (const [index, record] of records.entries()) {
    const parsed = schema.safeParse(record);
    if (!parsed.success) return { ok: false, message: `licensed ${template} record ${index + 1} is missing a source date, currency, unit, or required reporting period` };
    if (parsed.data.ticker !== ticker) return { ok: false, message: `licensed ${template} record ${index + 1} does not match requested ticker` };
    validated.push(parsed.data);
  }
  return { ok: true, records: validated };
}

/** Excludes well-known finance acronyms so “Build a DCF for NVDA” targets NVDA. */
function tickerFromQuery(query: string): string | undefined {
  const nonTickerAcronyms = new Set(["DCF", "EPS", "EBIT", "EBITDA", "SEC", "CEO", "CFO", "USD", "FY"]);
  return query.match(/\b[A-Z]{1,5}\b/g)?.find((candidate) => !nonTickerAcronyms.has(candidate));
}
