import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dcfInputFromEvidence } from "../src/index.js";

describe("dcfInputFromEvidence", () => {
  it("accepts exactly one source-bound, licensed valuation-input record", () => {
    const evidence = valuationEvidence({});

    const input = dcfInputFromEvidence([evidence], "NVDA");

    expect(input).toMatchObject({ ticker: "NVDA", freeCashFlow: 100, growthRate: 0.12, sourceEvidenceIds: [evidence.id] });
  });

  it("fails closed for incomplete provenance, conflicting candidates, or an unlicensed record", () => {
    const valid = valuationEvidence({});
    const missingDate = valuationEvidence({ source_as_of: undefined });
    const missingUnit = valuationEvidence({ unit: undefined });
    const unlicensed = { ...valid, authority: "secondary" as const };

    expect(dcfInputFromEvidence([missingDate], "NVDA")).toBeUndefined();
    expect(dcfInputFromEvidence([missingUnit], "NVDA")).toBeUndefined();
    expect(dcfInputFromEvidence([valid, valuationEvidence({})], "NVDA")).toBeUndefined();
    expect(dcfInputFromEvidence([unlicensed], "NVDA")).toBeUndefined();
  });
});

function valuationEvidence(overrides: Record<string, unknown>) {
  const record = {
    ticker: "NVDA", fiscal_period: "FY2025", free_cash_flow: 100,
    fcf_growth_rate: 0.12, terminal_growth_rate: 0.03, discount_rate: 0.1,
    projection_years: 5, currency: "USD", unit: "millions", source_as_of: "2026-02-20", ...overrides,
  };
  return {
    id: randomUUID(), sourceType: "market_data" as const, authority: "licensed" as const,
    title: "NVDA valuation inputs", content: JSON.stringify(record), sourceUrl: null,
    locator: "warehouse:valuation_inputs; row:1", entity: "NVDA", publishedAt: null,
    asOfDate: typeof record.source_as_of === "string" ? record.source_as_of : null,
    retrievedAt: new Date().toISOString(), contentHash: randomUUID().replaceAll("-", "").repeat(2),
    license: "licensed-test", tenantId: "org-1", requiredEntitlements: ["market-data"],
    metadata: { template: "valuation_inputs", fiscalPeriod: record.fiscal_period, currency: record.currency, unit: record.unit, sourceAsOf: record.source_as_of },
  };
}
