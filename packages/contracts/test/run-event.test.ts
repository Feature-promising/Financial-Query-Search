import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ResearchRunCommandSchema, RunEventSchema } from "../src/index.js";

describe("RunEventSchema", () => {
  it("accepts a finite, type-specific payload shape", () => {
    const parsed = RunEventSchema.parse({
      id: randomUUID(), runId: randomUUID(), sequence: 1, at: "2026-08-15T00:00:00.000Z", type: "tool_completed",
      payload: { taskId: "filing", toolId: "filing.search", ok: false, failure: { code: "UNAVAILABLE", message: "The requested capability is temporarily unavailable.", retryable: true }, estimatedCostUsd: 0 },
    });
    expect(parsed.type).toBe("tool_completed");
  });

  it("accepts queued-only pause and resume audit events", () => {
    const base = { id: randomUUID(), runId: randomUUID(), sequence: 1, at: "2026-08-15T00:00:00.000Z", payload: { reason: "user_requested", safeBoundary: "queued" } };
    expect(RunEventSchema.parse({ ...base, type: "run_paused" }).type).toBe("run_paused");
    expect(RunEventSchema.parse({ ...base, id: randomUUID(), sequence: 2, type: "run_resumed" }).type).toBe("run_resumed");
  });

  it("rejects free-form or type-mismatched event payloads", () => {
    const base = { id: randomUUID(), runId: randomUUID(), sequence: 1, at: "2026-08-15T00:00:00.000Z" };
    expect(RunEventSchema.safeParse({ ...base, type: "run_started", payload: { arbitrary: "unvalidated" } }).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...base, type: "tool_completed", payload: { taskId: "source", toolId: "retrieval.search", ok: false, estimatedCostUsd: 0 } }).success).toBe(false);
  });

  it("requires a tool snapshot for new commands while allowing queued legacy commands to drain", () => {
    const base = {
      runId: randomUUID(), conversationId: randomUUID(),
      scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] },
      question: "Analyze NVDA", requestedAt: "2026-08-15T00:00:00.000Z",
    };
    expect(ResearchRunCommandSchema.safeParse({ ...base, version: "v1" }).success).toBe(true);
    expect(ResearchRunCommandSchema.safeParse({ ...base, version: "v2" }).success).toBe(false);
    expect(ResearchRunCommandSchema.safeParse({
      ...base,
      version: "v2",
      toolManifestSnapshot: [{ id: "filing.search", version: "sec-edgar-v1", capability: "sec_filing_retrieval", requiredEntitlements: [], timeoutMs: 20_000, enabled: true }],
    }).success).toBe(true);
    expect(ResearchRunCommandSchema.safeParse({
      ...base,
      version: "v2",
      toolManifestSnapshot: [{ id: "report.compose", version: "v1", capability: "report", requiredEntitlements: [], timeoutMs: 5_000, enabled: true, visibility: "internal" }],
    }).success).toBe(false);
  });
});
