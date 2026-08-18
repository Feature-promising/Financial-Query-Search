import { describe, expect, it } from "vitest";
import { SecEdgarClient, SecFilingTool, type ToolContext } from "../../src/index.js";

const fetchMock = async (input: string): Promise<Response> => {
  if (input.includes("company_tickers")) return Response.json({ "0": { ticker: "NVDA", cik_str: 1045810, title: "NVIDIA CORP" } });
  if (input.includes("submissions")) return Response.json({ filings: { recent: { form: ["10-K"], accessionNumber: ["0001045810-25-000001"], primaryDocument: ["report.htm"], filingDate: ["2025-02-20"] } } });
  return new Response("<html><body><h1>Item 7</h1><p>Revenue increased.</p></body></html>", { status: 200 });
};

describe("SecFilingTool", () => {
  it("returns primary, locatable evidence from a mocked EDGAR filing", async () => {
    const tool = new SecFilingTool(new SecEdgarClient({ userAgent: "Research Agent test@example.com", fetch: fetchMock }));
    const context: ToolContext = { runId: "run-1", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] }, remainingToolCalls: 1 };
    const result = await tool.invoke({ query: "Analyze NVDA 10-K" }, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.filingType).toBe("10-K");
      expect(result.evidence[0]?.authority).toBe("primary");
      expect(result.evidence[0]?.sourceUrl).toContain("sec.gov/Archives");
      expect(result.evidence[0]?.locator).toContain("normalized characters 1-");
      expect(result.evidence[0]?.metadata).toMatchObject({ excerptIndex: 1, excerptCount: 1 });
    }
  });

  it("uses the requested reporting year instead of silently substituting the latest filing", async () => {
    const fetchByPeriod = async (input: string): Promise<Response> => {
      if (input.includes("company_tickers")) return Response.json({ "0": { ticker: "NVDA", cik_str: 1045810, title: "NVIDIA CORP" } });
      if (input.includes("submissions")) return Response.json({
        filings: { recent: {
          form: ["10-K", "10-K"], accessionNumber: ["0001045810-26-000001", "0001045810-25-000001"], primaryDocument: ["latest.htm", "fy2025.htm"],
          filingDate: ["2026-02-20", "2025-02-20"], reportDate: ["2026-01-25", "2025-01-26"],
        } },
      });
      return new Response("<html><body>Fiscal-year disclosure.</body></html>", { status: 200 });
    };
    const tool = new SecFilingTool(new SecEdgarClient({ userAgent: "Research Agent test@example.com", fetch: fetchByPeriod }));
    const context: ToolContext = { runId: "run-1", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] }, remainingToolCalls: 1 };
    const result = await tool.invoke({ query: "Analyze NVDA", period: "2025" }, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.reportingPeriod).toBe("2025-01-26");
      expect(result.evidence[0]?.asOfDate).toBe("2025-01-26");
      expect(result.evidence[0]?.metadata.reportingPeriod).toBe("2025-01-26");
    }
  });

  it("searches SEC historical submission shards for an older requested year", async () => {
    const historicalFetch = async (input: string): Promise<Response> => {
      if (input.includes("company_tickers")) return Response.json({ "0": { ticker: "NVDA", cik_str: 1045810, title: "NVIDIA CORP" } });
      if (input.endsWith("CIK0001045810-submissions-001.json")) return Response.json({
        form: ["10-K"], accessionNumber: ["0001045810-24-000001"], primaryDocument: ["fy2024.htm"], filingDate: ["2024-02-21"], reportDate: ["2024-01-28"],
      });
      if (input.includes("submissions")) return Response.json({
        filings: {
          recent: { form: ["10-K"], accessionNumber: ["0001045810-26-000001"], primaryDocument: ["latest.htm"], filingDate: ["2026-02-20"], reportDate: ["2026-01-25"] },
          files: [{ name: "CIK0001045810-submissions-001.json" }],
        },
      });
      return new Response("<html><body>Historical fiscal-year disclosure.</body></html>", { status: 200 });
    };
    const tool = new SecFilingTool(new SecEdgarClient({ userAgent: "Research Agent test@example.com", fetch: historicalFetch }));
    const context: ToolContext = { runId: "run-1", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] }, remainingToolCalls: 1 };
    const result = await tool.invoke({ query: "Analyze NVDA", period: "2024" }, context);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reportingPeriod).toBe("2024-01-28");
  });
});
