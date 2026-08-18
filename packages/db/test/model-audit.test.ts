import { describe, expect, it } from "vitest";
import { PostgresModelAuditSink } from "../src/index.js";

describe("PostgresModelAuditSink", () => {
  it("stores token usage and a nullable cost without research content", async () => {
    const calls: unknown[][] = [];
    const sink = new PostgresModelAuditSink({ query: async (_sql, values = []) => { calls.push(values); return { rows: [], rowCount: 1 }; } });
    await sink.write({ runId: "38e211f9-0c7a-45e5-aeae-6e1c69d28f44", organizationId: "org-1", modelId: "bedrock.model", operation: "claim_composition", invokedAt: "2026-08-14T00:00:00.000Z", inputTokens: 100, outputTokens: 25, totalTokens: 125, estimatedCostUsd: null });
    expect(calls[0]?.slice(0, 9)).toEqual(["38e211f9-0c7a-45e5-aeae-6e1c69d28f44", "org-1", "bedrock.model", "claim_composition", "2026-08-14T00:00:00.000Z", 100, 25, 125, null]);
    expect(calls[0]?.[11]).toMatchObject({ type: "audit.model_invocation.recorded", data: { modelId: "bedrock.model", totalTokens: 125, estimatedCostUsd: null } });
  });
});
