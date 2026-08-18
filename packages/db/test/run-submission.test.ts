import { describe, expect, it } from "vitest";
import { PostgresRunSubmissionStore } from "../src/index.js";

describe("PostgresRunSubmissionStore", () => {
  it("uses one statement to snapshot the command with the run, user message, and durable outbox command", async () => {
    const calls: string[] = [];
    const store = new PostgresRunSubmissionStore({ query: async (sql) => { calls.push(sql); return { rows: [{ submission: "submitted" }], rowCount: 1 }; } });
    const accepted = await store.submit({
      runId: "6bf28e59-4694-4db3-9d6b-9c6b8d8e5b1b", organizationId: "org-1", actorUserId: "u-1", isOrganizationAdmin: false, conversationId: "7d6e5b1b-4694-4db3-9d6b-9c6b8d8e5b1b", question: "Analyze NVDA",
      budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 },
      command: { version: "v2", runId: "6bf28e59-4694-4db3-9d6b-9c6b8d8e5b1b", conversationId: "7d6e5b1b-4694-4db3-9d6b-9c6b8d8e5b1b", scope: { organizationId: "org-1", userId: "u-1", roles: ["researcher"], entitlements: [] }, question: "Analyze NVDA", toolManifestSnapshot: [{ id: "filing.search", version: "1", capability: "sec_filing_retrieval", requiredEntitlements: [], timeoutMs: 20_000, enabled: true }], requestedAt: "2026-08-14T08:00:00.000Z" },
      maxActiveRunsPerUser: 2,
      maxActiveRunsPerOrganization: 10,
    });
    expect(accepted).toBe("submitted");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("pg_advisory_xact_lock(hashtext($2))");
    expect(calls[0]).toContain("r.status IN ('queued', 'running')");
    expect(calls[0]).toContain("jsonb_build_object('command', $10::jsonb)");
    expect(calls[0]).toContain("created_outbox");
    expect(calls[0]).toContain("INSERT INTO messages (conversation_id, organization_id, role, content, run_id)");
    expect(calls[0]).toContain("SELECT conversation_id, $2, 'user', $8, id FROM created_run");
    expect(calls[0]).toContain("INSERT INTO outbox_events (id, event_type, aggregate_id, organization_id, payload)");
  });

  it("returns an explicit quota result rather than treating a limit as a missing conversation", async () => {
    const store = new PostgresRunSubmissionStore({ query: async () => ({ rows: [{ submission: "active_run_limit_exceeded" }], rowCount: 1 }) });
    const result = await store.submit({
      runId: "6bf28e59-4694-4db3-9d6b-9c6b8d8e5b1b", organizationId: "org-1", actorUserId: "u-1", isOrganizationAdmin: false, conversationId: "7d6e5b1b-4694-4db3-9d6b-9c6b8d8e5b1b", question: "Analyze NVDA",
      budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 },
      command: { version: "v2", runId: "6bf28e59-4694-4db3-9d6b-9c6b8d8e5b1b", conversationId: "7d6e5b1b-4694-4db3-9d6b-9c6b8d8e5b1b", scope: { organizationId: "org-1", userId: "u-1", roles: ["researcher"], entitlements: [] }, question: "Analyze NVDA", toolManifestSnapshot: [{ id: "filing.search", version: "1", capability: "sec_filing_retrieval", requiredEntitlements: [], timeoutMs: 20_000, enabled: true }], requestedAt: "2026-08-14T08:00:00.000Z" },
      maxActiveRunsPerUser: 2,
      maxActiveRunsPerOrganization: 10,
    });
    expect(result).toBe("active_run_limit_exceeded");
  });
});
