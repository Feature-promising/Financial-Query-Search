import { describe, expect, it } from "vitest";
import { findFinancialEvidenceConflicts, type EvidenceItem } from "../src/index.js";

describe("findFinancialEvidenceConflicts", () => {
  it("flags different canonical values from the same source-as-of and financial dimensions", () => {
    const conflicts = findFinancialEvidenceConflicts([
      financialEvidence("10000000-0000-4000-8000-000000000001", { ticker: "NVDA", fiscal_period: "FY2025", revenue: "130.5", currency: "USD", unit: "USD millions", source_as_of: "2026-02-20" }),
      financialEvidence("10000000-0000-4000-8000-000000000002", { ticker: "NVDA", fiscal_period: "FY2025", revenue: "131.5", currency: "USD", unit: "USD millions", source_as_of: "2026-02-20" }),
    ]);

    expect(conflicts).toEqual([{
      key: { entity: "NVDA", period: "FY2025", sourceAsOf: "2026-02-20", metric: "revenue", currency: "USD", unit: "USD millions" },
      evidenceIds: ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"],
    }]);
  });

  it("does not treat a later source revision or a different unit as the same observation", () => {
    const original = financialEvidence("10000000-0000-4000-8000-000000000003", { ticker: "NVDA", fiscal_period: "FY2025", revenue: 130, currency: "USD", unit: "USD millions", source_as_of: "2026-02-20" });
    const revision = financialEvidence("10000000-0000-4000-8000-000000000004", { ticker: "NVDA", fiscal_period: "FY2025", revenue: 131, currency: "USD", unit: "USD millions", source_as_of: "2026-03-01" });
    const differentUnit = financialEvidence("10000000-0000-4000-8000-000000000005", { ticker: "NVDA", fiscal_period: "FY2025", revenue: 130_000, currency: "USD", unit: "USD thousands", source_as_of: "2026-02-20" });

    expect(findFinancialEvidenceConflicts([original, revision, differentUnit])).toEqual([]);
  });

  it("ignores unstructured or non-financial evidence", () => {
    const filing: EvidenceItem = {
      ...financialEvidence("10000000-0000-4000-8000-000000000006", { ticker: "NVDA", fiscal_period: "FY2025", revenue: 1, currency: "USD", unit: "USD millions", source_as_of: "2026-02-20" }),
      sourceType: "sec_filing",
      content: "Revenue information appears on page 10.",
    };
    expect(findFinancialEvidenceConflicts([filing])).toEqual([]);
  });
});

function financialEvidence(id: string, record: Record<string, string | number>): EvidenceItem {
  const content = JSON.stringify(record);
  return {
    id,
    sourceType: "market_data",
    authority: "licensed",
    title: "NVDA canonical financial record",
    content,
    sourceUrl: null,
    locator: "warehouse:company_fundamentals; row:1",
    entity: "NVDA",
    publishedAt: null,
    asOfDate: "2026-02-20",
    retrievedAt: "2026-08-15T00:00:00.000Z",
    contentHash: `${id.replaceAll("-", "")}abcdef`,
    license: "approved-market-data-license",
    tenantId: "org-1",
    requiredEntitlements: ["market-data"],
    metadata: { fiscalPeriod: record.fiscal_period, sourceAsOf: record.source_as_of, currency: record.currency, unit: record.unit },
  };
}
