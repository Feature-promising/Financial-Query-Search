import { describe, expect, it } from "vitest";
import { PostgresRunStore } from "../src/index.js";
import type { ResearchScope, RunEvent } from "@research/contracts";

const scope: ResearchScope = { organizationId: "tenant-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
const event: RunEvent = {
  id: "33e0e7c8-352f-49f7-94bb-98d85bcc8e62",
  runId: "8e89d72d-8c03-4308-ae94-d50ddb03c6d7",
  sequence: 1,
  type: "run_started",
  at: "2026-08-14T08:00:00.000Z",
  payload: { question: "Analyze NVDA" },
};

describe("PostgresRunStore", () => {
  it("atomically appends a run event and a metadata-only lifecycle outbox event", async () => {
    let sql = "";
    let values: unknown[] = [];
    const store = new PostgresRunStore({ query: async (receivedSql, receivedValues = []) => {
      sql = receivedSql;
      values = receivedValues;
      return { rows: [{ appended: true }], rowCount: 1 };
    } });

    await store.appendEvent(scope, event);

    expect(sql).toContain("INSERT INTO run_events (id, run_id, organization_id, sequence, type, payload)");
    expect(sql).toContain("INSERT INTO domain_event_outbox");
    const domainEvent = values[10] as { data: unknown; tenantId: string };
    expect(domainEvent).toMatchObject({ tenantId: "tenant-1", data: { runId: event.runId, sequence: 1, eventType: "run_started" } });
    expect(JSON.stringify(domainEvent)).not.toContain("Analyze NVDA");
  });

  it("rejects a malformed persisted run rather than casting its budget or status", async () => {
    const store = new PostgresRunStore({ query: async (sql) => {
      if (sql.includes("SELECT r.*, c.created_by")) {
        return {
          rows: [{
            id: "8e89d72d-8c03-4308-ae94-d50ddb03c6d7",
            organization_id: "tenant-1",
            conversation_id: "b767609b-c8fa-4d79-a441-b2c6902f9e7e",
            created_by: "user-1",
            question: "Analyze NVDA",
            budget: { maxTasks: "unbounded" },
            status: "running",
            state: {},
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    } });

    await expect(store.get(scope, "8e89d72d-8c03-4308-ae94-d50ddb03c6d7")).rejects.toThrow();
  });

  it("writes pause/resume lifecycle events and returns the resumed immutable command to the outbox", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const store = new PostgresRunStore({ query: async (sql, values = []) => {
      calls.push({ sql, values });
      return { rows: [{ outcome: sql.includes("SET status='paused'") ? "paused" : "resumed" }], rowCount: 1 };
    } });
    const pause = { ...event, type: "run_paused" as const, payload: { reason: "user_requested" as const, safeBoundary: "queued" as const } };
    const resume = { ...event, id: "794e73c6-9e33-4efc-a809-4cd54a2b2ff3", sequence: 2, type: "run_resumed" as const, payload: { reason: "user_requested" as const, safeBoundary: "queued" as const } };

    expect(await store.pause(scope, event.runId, pause)).toBe("paused");
    expect(await store.resume(scope, event.runId, resume)).toBe("resumed");
    expect(calls[0]?.sql).toContain("SET status='paused'");
    expect(calls[0]?.sql).toContain("INSERT INTO domain_event_outbox");
    expect(calls[1]?.sql).toContain("SET status='queued'");
    expect(calls[1]?.sql).toContain("INSERT INTO outbox_events");
  });
});
