import { describe, expect, it } from "vitest";
import { PostgresToolAuditSink } from "../src/index.js";

describe("PostgresToolAuditSink", () => {
  it("persists hashes, evidence identifiers and cost without raw inputs", async () => {
    const calls: unknown[][] = [];
    const sink = new PostgresToolAuditSink({ query: async (_sql, values) => { calls.push(values ?? []); return { rows: [], rowCount: 1 }; } });
    await sink.write({ runId: "38e211f9-0c7a-45e5-aeae-6e1c69d28f44", organizationId: "org-1", toolId: "filing.search", idempotencyKey: "task:stable-key", at: "2026-08-14T08:00:00.000Z", ok: true, inputHash: "input-hash", outputHash: "output-hash", evidenceIds: ["e-1"], estimatedCostUsd: 0.02, durationMs: 12 });
    expect(calls[0]).toContain("input-hash");
    expect(calls[0]).toContain("task:stable-key");
    expect(calls[0]).toContain(0.02);
    expect(calls[0]?.[14]).toMatchObject({ type: "audit.tool_invocation.recorded", data: { toolId: "filing.search", idempotencyKey: "task:stable-key" } });
  });
});
