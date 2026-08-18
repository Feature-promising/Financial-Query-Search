import { describe, expect, it } from "vitest";
import { ingestSecFilingBatch } from "../src/ingestion/sec-ingestion-batch.js";

describe("ingestSecFilingBatch", () => {
  it("continues independent tickers and returns content-free aggregate results", async () => {
    const result = await ingestSecFilingBatch({
      ingest: async (ticker) => {
        if (ticker === "AMD") throw new Error("provider token=secret must not leave task diagnostics");
        return ticker === "NVDA" ? evidence() : undefined;
      },
    }, ["NVDA", "AMD", "NVDA", "MSFT"], "org-1");

    expect(result).toEqual({ requestedTickerCount: 3, ingestedEvidenceCount: 1, failedTickerCount: 1 });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("AMD");
  });

  it("rejects empty or unbounded batches before provider calls", async () => {
    let calls = 0;
    const ingestor = { ingest: async () => { calls += 1; return evidence(); } };

    await expect(ingestSecFilingBatch(ingestor, [], "org-1")).rejects.toThrow("between 1 and 100");
    await expect(ingestSecFilingBatch(ingestor, Array.from({ length: 101 }, (_, index) => `T${index}`), "org-1")).rejects.toThrow("between 1 and 100");
    expect(calls).toBe(0);
  });
});

function evidence() {
  return {
    id: "f5d890db-010e-4ac1-b086-805a3fe01ec4", sourceType: "sec_filing" as const, authority: "primary" as const,
    title: "10-K", content: "Evidence", sourceUrl: null, locator: "p.1", entity: "NVDA", publishedAt: null, asOfDate: null,
    retrievedAt: "2026-08-15T00:00:00.000Z", contentHash: "a".repeat(64), license: "SEC", tenantId: "org-1", metadata: {},
  };
}
