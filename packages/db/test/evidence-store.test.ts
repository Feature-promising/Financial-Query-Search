import { describe, expect, it } from "vitest";
import { PostgresEvidenceStore } from "../src/index.js";

describe("PostgresEvidenceStore", () => {
  it("does not return licensed evidence when the caller lacks its data entitlement", async () => {
    const store = new PostgresEvidenceStore({
      query: async () => ({ rows: [{
        id: "d1515689-4c6f-456d-9f31-e07e1fbaedfe", source_type: "market_data", authority: "licensed", source_url: null, locator: "row:1", content_hash: "a".repeat(64), content: "Close price: 100.", organization_id: "org-1",
        metadata: { title: "Licensed price", entity: "EXM", publishedAt: null, asOfDate: "2026-08-13", retrievedAt: "2026-08-14T00:00:00.000Z", license: "Licensed vendor", requiredEntitlements: ["market-data"] },
      }], rowCount: 1 }),
    });

    const item = await store.get({ organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] }, "d1515689-4c6f-456d-9f31-e07e1fbaedfe");
    expect(item).toBeUndefined();
  });

  it("writes the tenant key into the run-evidence bridge", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const store = new PostgresEvidenceStore({
      query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.startsWith("SELECT organization_id")) return { rows: [{ organization_id: "org-1" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    });
    const item = {
      id: "f5d890db-010e-4ac1-b086-805a3fe01ec4", tenantId: "org-1", sourceType: "sec_filing" as const, authority: "primary" as const,
      title: "10-K", content: "Evidence", sourceUrl: null, locator: "p.1", entity: "NVDA", publishedAt: null, asOfDate: null,
      retrievedAt: "2026-08-15T00:00:00.000Z", contentHash: "a".repeat(64), license: "SEC", metadata: {},
    };

    await store.save({ organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] }, "2ca713b3-4650-4443-8387-d3f0287c8b4b", [item]);

    expect(calls.find((call) => call.sql.includes("INSERT INTO research_run_evidence"))?.values).toEqual(["2ca713b3-4650-4443-8387-d3f0287c8b4b", item.id, "org-1"]);
  });
});
