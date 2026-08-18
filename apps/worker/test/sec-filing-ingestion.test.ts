import { describe, expect, it } from "vitest";
import { SecFilingIngestionService } from "../src/index.js";
import type { EvidenceItem } from "@research/contracts";

describe("SecFilingIngestionService", () => {
  it("uses a stable evidence identity for repeated scheduled ingestion", async () => {
    const stored: EvidenceItem[] = [];
    const service = new SecFilingIngestionService({ findLatestFiling: async () => ({ ticker: "NVDA", companyName: "NVIDIA", cik: "0001045810", accessionNumber: "0001045810-26-000001", form: "10-K", filingDate: "2026-02-20", reportDate: "2026-01-25", primaryDocument: "report.htm", url: "https://www.sec.gov/report.htm" }), getFilingText: async () => "filing content" }, { store: async (items) => { stored.push(items[0]!); return items; } });
    await service.ingest("NVDA", "org-1");
    await service.ingest("NVDA", "org-1");
    expect(stored[0]?.id).toBe(stored[1]?.id);
    expect(stored[0]).toMatchObject({ asOfDate: "2026-01-25", metadata: { reportingPeriod: "2026-01-25" }, graphRelations: [{ subject: "NVDA", predicate: "ISSUED_BY", object: "NVIDIA" }] });
  });
});
