import { describe, expect, it } from "vitest";
import { FinancialDataTool } from "../src/index.js";

describe("FinancialDataTool", () => {
  it("uses a whitelisted warehouse template and returns licensed evidence", async () => {
    let requestedAsOfDate: string | number | undefined;
    const tool = new FinancialDataTool({ query: async (template, parameters) => {
      requestedAsOfDate = parameters.asOfDate;
      return [{ template, ticker: parameters.ticker, fiscal_period: "FY2025", revenue: 100, currency: "USD", unit: "millions", source_as_of: "2026-02-20" }];
    } }, "licensed-test-data");
    const result = await tool.invoke({ query: "Analyze NVDA revenue", template: "company_fundamentals" }, { runId: "run-1", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: ["market-data"] }, remainingToolCalls: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence[0]?.license).toBe("licensed-test-data");
      expect(result.evidence[0]?.requiredEntitlements).toEqual(["market-data"]);
      expect(result.evidence[0]?.metadata).toMatchObject({ fiscalPeriod: "FY2025", currency: "USD", unit: "millions", sourceAsOf: "2026-02-20" });
    }
    expect(requestedAsOfDate).toBe("9999-12-31");
  });

  it("does not mistake a valuation acronym for a ticker", async () => {
    const tool = new FinancialDataTool({ query: async (_template, parameters) => [{ ticker: parameters.ticker, fiscal_period: "FY2025", free_cash_flow: 100, fcf_growth_rate: 0.1, terminal_growth_rate: 0.03, discount_rate: 0.1, projection_years: 5, currency: "USD", unit: "millions", source_as_of: "2026-02-20" }] }, "licensed-test-data");
    const result = await tool.invoke({ query: "Build a DCF valuation for NVDA", template: "valuation_inputs" }, { runId: "run-1", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: ["market-data"] }, remainingToolCalls: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ticker).toBe("NVDA");
  });

  it("fails closed when a licensed record lacks the source-bound financial metadata", async () => {
    const tool = new FinancialDataTool({ query: async (_template, parameters) => [{ ticker: parameters.ticker, revenue: 100 }] }, "licensed-test-data");
    const result = await tool.invoke({ query: "Analyze NVDA revenue", template: "company_fundamentals" }, { runId: "run-1", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: ["market-data"] }, remainingToolCalls: 1 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toContain("source date");
  });

  it("does not query licensed warehouse data without the market-data entitlement", async () => {
    let calls = 0;
    const tool = new FinancialDataTool({ query: async () => { calls += 1; return []; } }, "licensed-test-data");
    const result = await tool.invoke({ query: "Analyze NVDA revenue" }, { runId: "run-1", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] }, remainingToolCalls: 1 });

    expect(result).toMatchObject({ ok: false, failure: { code: "UNAUTHORIZED" } });
    expect(calls).toBe(0);
  });
});
