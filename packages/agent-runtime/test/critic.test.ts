import { describe, expect, it } from "vitest";
import { emptyPrioritizedMemoryContext } from "@research/memory";
import type { EvidenceItem } from "@research/contracts";
import { critic, type ResearchState } from "../src/index.js";

describe("critic", () => {
  it("refuses a claim that relies on unresolved canonical financial-data conflicts", () => {
    const first = financialEvidence("20000000-0000-4000-8000-000000000001", 130);
    const second = financialEvidence("20000000-0000-4000-8000-000000000002", 131);
    const claimId = "30000000-0000-4000-8000-000000000001";
    const result = critic({
      run: {
        id: "40000000-0000-4000-8000-000000000001",
        conversationId: "50000000-0000-4000-8000-000000000001",
        scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: ["market-data"] },
        question: "Analyze NVDA revenue",
        status: "running",
        budget,
        startedAt: "2026-08-15T00:00:00.000Z",
        finishedAt: null,
      },
      conversation: { conversationId: "50000000-0000-4000-8000-000000000001", recentMessages: [], memories: emptyPrioritizedMemoryContext() },
      tasks: [{ id: "financials", title: "Financials", objective: "Retrieve financial data", dependsOn: [], allowedTools: ["financial.get"], acceptanceCriteria: ["source-bound record"], status: "completed" }],
      evidence: [first, second],
      claims: [{ id: claimId, text: "Revenue was 130.", evidenceIds: [first.id], confidence: 0.9, qualification: null }],
      budget,
      criticRepairs: 0,
    } satisfies ResearchState);

    expect(result).toMatchObject({
      publishable: false,
      rejectedClaimIds: [claimId],
      reason: "One or more claims rely on unresolved canonical financial-data conflicts.",
    });
  });
});

const budget = { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 } as const;

function financialEvidence(id: string, revenue: number): EvidenceItem {
  const content = JSON.stringify({ ticker: "NVDA", fiscal_period: "FY2025", revenue, currency: "USD", unit: "USD millions", source_as_of: "2026-02-20" });
  return {
    id,
    sourceType: "market_data",
    authority: "licensed",
    title: "NVDA FY2025 financial record",
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
    metadata: { fiscalPeriod: "FY2025", sourceAsOf: "2026-02-20", currency: "USD", unit: "USD millions" },
  };
}
