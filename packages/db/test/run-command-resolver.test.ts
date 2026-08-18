import { describe, expect, it } from "vitest";
import { PostgresResearchRunCommandResolver } from "../src/index.js";
import type { ResearchRunCommand } from "@research/contracts";

const command: ResearchRunCommand = {
  version: "v2",
  runId: "b471c5da-4a37-4ad6-a801-bd5103e12446",
  conversationId: "a4c5a42e-6c43-48de-9fe3-9e19c7857e23",
  scope: { organizationId: "tenant-1", userId: "user-1", roles: ["researcher"], entitlements: ["market-data"] },
  question: "Analyze NVDA",
  toolManifestSnapshot: [{ id: "filing.search", version: "1", capability: "sec_filing_retrieval", requiredEntitlements: [], timeoutMs: 20_000, enabled: true }],
  requestedAt: "2026-08-14T08:00:00.000Z",
};

describe("PostgresResearchRunCommandResolver", () => {
  it("returns only the API-committed run command for a run", async () => {
    let sql = "";
    let values: unknown[] | undefined;
    const resolver = new PostgresResearchRunCommandResolver({
      query: async (receivedSql, receivedValues) => {
        sql = receivedSql;
        values = receivedValues;
        return { rows: [{ payload: command }], rowCount: 1 };
      },
    });

    await expect(resolver.resolve(command.runId)).resolves.toEqual(command);
    expect(values).toEqual([command.runId]);
    expect(sql).toContain("event.organization_id = run.organization_id");
  });

  it("does not authorize a delivery when no durable command exists", async () => {
    const resolver = new PostgresResearchRunCommandResolver({ query: async () => ({ rows: [], rowCount: 0 }) });
    await expect(resolver.resolve(command.runId)).resolves.toBeUndefined();
  });
});
