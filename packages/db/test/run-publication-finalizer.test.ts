import { describe, expect, it } from "vitest";
import { PostgresResearchRunPublicationFinalizer } from "../src/index.js";

const scope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"] as const, entitlements: [] };

describe("PostgresResearchRunPublicationFinalizer", () => {
  it("atomically writes a completed report, assistant message, and terminal run transition", async () => {
    let sql = "";
    let values: unknown[] | undefined;
    const finalizer = new PostgresResearchRunPublicationFinalizer({
      query: async (receivedSql, receivedValues) => {
        sql = receivedSql;
        values = receivedValues;
        return { rows: [{ finalized: true }], rowCount: 1 };
      },
    });

    await finalizer.finalize(scope, {
      runId: "a9362da9-24d1-4711-9dd3-52d620a750e0", ownerUserId: "user-1", status: "completed", answer: "# Research",
      report: { markdown: "# Research", citations: [] },
      researchMemory: researchMemory(),
      terminalEvent: { id: "b9362da9-24d1-4711-9dd3-52d620a750e0", runId: "a9362da9-24d1-4711-9dd3-52d620a750e0", sequence: 8, type: "completed", at: "2026-08-15T00:00:00.000Z", payload: { answer: "# Research", evidenceCount: 1 } },
    });

    expect(sql).toContain("created_report AS");
    expect(sql).toContain("created_research_memory AS");
    expect(sql).toContain("finished_run AS");
    expect(sql).toContain("updated_conversation AS");
    expect(sql).toContain("created_message AS");
    expect(sql).toContain("terminal_run_event AS");
    expect(sql).toContain("terminal_lifecycle_event AS");
    expect(sql).toContain("INSERT INTO messages (conversation_id, organization_id, role, content, run_id)");
    expect(sql).toContain("INSERT INTO run_events (id, run_id, organization_id, sequence, type, payload)");
    expect(sql).toContain("$6 <> 'completed' OR (EXISTS (SELECT 1 FROM created_report) AND EXISTS (SELECT 1 FROM created_research_memory))");
    expect(sql).toContain("EXISTS (SELECT 1 FROM created_research_memory)");
    expect(values?.[5]).toBe("completed");
  });

  it("rejects a completed publication with no controlled report before writing", async () => {
    let calls = 0;
    const finalizer = new PostgresResearchRunPublicationFinalizer({ query: async () => { calls += 1; return { rows: [], rowCount: 0 }; } });
    await expect(finalizer.finalize(scope, {
      runId: "a9362da9-24d1-4711-9dd3-52d620a750e0", ownerUserId: "user-1", status: "completed", answer: "# Research",
      terminalEvent: { id: "b9362da9-24d1-4711-9dd3-52d620a750e0", runId: "a9362da9-24d1-4711-9dd3-52d620a750e0", sequence: 8, type: "completed", at: "2026-08-15T00:00:00.000Z", payload: { answer: "# Research", evidenceCount: 1 } },
    })).rejects.toThrow("no controlled report");
    expect(calls).toBe(0);
  });

  it("rejects a completed publication with no publication-bound research memory", async () => {
    let calls = 0;
    const finalizer = new PostgresResearchRunPublicationFinalizer({ query: async () => { calls += 1; return { rows: [], rowCount: 0 }; } });
    await expect(finalizer.finalize(scope, {
      runId: "a9362da9-24d1-4711-9dd3-52d620a750e0", ownerUserId: "user-1", status: "completed", answer: "# Research",
      report: { markdown: "# Research", citations: [] },
      terminalEvent: { id: "b9362da9-24d1-4711-9dd3-52d620a750e0", runId: "a9362da9-24d1-4711-9dd3-52d620a750e0", sequence: 8, type: "completed", at: "2026-08-15T00:00:00.000Z", payload: { answer: "# Research", evidenceCount: 1 } },
    })).rejects.toThrow("publication-bound research memory");
    expect(calls).toBe(0);
  });

  it("rejects a research memory candidate from another run or tenant before writing", async () => {
    let calls = 0;
    const finalizer = new PostgresResearchRunPublicationFinalizer({ query: async () => { calls += 1; return { rows: [], rowCount: 0 }; } });
    await expect(finalizer.finalize(scope, {
      runId: "a9362da9-24d1-4711-9dd3-52d620a750e0", ownerUserId: "user-1", status: "completed", answer: "# Research",
      report: { markdown: "# Research", citations: [] },
      researchMemory: { ...researchMemory(), tenantId: "org-2" },
      terminalEvent: { id: "b9362da9-24d1-4711-9dd3-52d620a750e0", runId: "a9362da9-24d1-4711-9dd3-52d620a750e0", sequence: 8, type: "completed", at: "2026-08-15T00:00:00.000Z", payload: { answer: "# Research", evidenceCount: 1 } },
    })).rejects.toThrow("not bound to this publication");
    expect(calls).toBe(0);
  });

function researchMemory() {
  return {
    scope: "research" as const, tenantId: "org-1", userId: null, conversationId: null, visibility: "organization" as const,
    content: "# Research", sourceRunId: "a9362da9-24d1-4711-9dd3-52d620a750e0", expiresAt: null,
    retentionPolicy: "organization_default" as const, metadata: { researchMemoryVersion: 1, question: "Research", entities: [], tickers: [], asOfDates: [] },
  };
}
});
