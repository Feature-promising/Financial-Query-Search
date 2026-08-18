import { describe, expect, it } from "vitest";
import { rerankEvidence, type EvidenceItem } from "../src/index.js";

describe("rerankEvidence", () => {
  it("prefers an equally authoritative, entity-matched source nearest the requested as-of date", () => {
    const older = evidence("60000000-0000-4000-8000-000000000001", "2024-12-31");
    const nearest = evidence("60000000-0000-4000-8000-000000000002", "2025-12-30");

    expect(rerankEvidence({ text: "NVDA revenue", asOfDate: "2025-12-31" }, [older, nearest], 2).map((item) => item.id))
      .toEqual([nearest.id, older.id]);
  });

  it("does not let temporal proximity outrank a primary filing", () => {
    const primary = { ...evidence("60000000-0000-4000-8000-000000000003", "2024-01-01"), sourceType: "sec_filing" as const, authority: "primary" as const, requiredEntitlements: undefined, license: "SEC EDGAR" };
    const licensed = evidence("60000000-0000-4000-8000-000000000004", "2025-12-31");

    expect(rerankEvidence({ text: "NVDA revenue", asOfDate: "2025-12-31" }, [licensed, primary], 2)[0]?.id).toBe(primary.id);
  });
});

function evidence(id: string, asOfDate: string): EvidenceItem {
  return {
    id,
    sourceType: "market_data",
    authority: "licensed",
    title: "NVDA revenue",
    content: "NVDA revenue record",
    sourceUrl: null,
    locator: "warehouse:company_fundamentals; row:1",
    entity: "NVDA",
    publishedAt: null,
    asOfDate,
    retrievedAt: "2026-08-15T00:00:00.000Z",
    contentHash: `${id.replaceAll("-", "")}abcdef`,
    license: "approved-market-data-license",
    tenantId: "org-1",
    requiredEntitlements: ["market-data"],
    metadata: { sourceAsOf: asOfDate },
  };
}
