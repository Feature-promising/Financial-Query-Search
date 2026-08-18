import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresMemoryStore } from "../src/index.js";
import type { SqlClient } from "../src/types.js";

describe("PostgresMemoryStore", () => {
  it("uses the database preference key to atomically replace a confirmed preference", async () => {
    const id = randomUUID();
    let sql = "";
    let values: unknown[] = [];
    const store = new PostgresMemoryStore({ query: async (statement, receivedValues = []) => {
      sql = statement;
      values = receivedValues;
      return { rowCount: 1, rows: [{
        id, organization_id: "org-a", user_id: "user-a", conversation_id: null, scope: "long_term", visibility: "private",
        content: "Confirmed valuation method: DCF", source_run_id: null, expires_at: null, retention_policy: "user_managed",
        metadata: { userConfirmed: true, preferenceKey: "valuation_method", preferenceValue: "DCF" }, preference_key: "valuation_method",
      }] };
    } });

    await store.upsertConfirmedPreference({
      scope: "long_term", tenantId: "org-a", userId: "user-a", visibility: "private", content: "Confirmed valuation method: DCF", sourceRunId: null, expiresAt: null,
      retentionPolicy: "user_managed", metadata: { userConfirmed: true, preferenceKey: "valuation_method", preferenceValue: "DCF" },
    });

    expect(sql).toContain("preference_key");
    expect(sql).toContain("ON CONFLICT (organization_id, user_id, preference_key)");
    expect(values.at(-1)).toBe("valuation_method");
  });

  it("distinguishes an explicit null expiry from an omitted expiry patch", async () => {
    const id = randomUUID();
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client: SqlClient = {
      query: async (sql, values) => {
        calls.push({ sql, values });
        return { rowCount: 1, rows: [{
          id, organization_id: "org-a", user_id: "user-a", conversation_id: null, scope: "long_term", visibility: "private",
          content: "DCF", source_run_id: null, expires_at: null, retention_policy: "user_managed", metadata: {},
        }] };
      },
    };
    const store = new PostgresMemoryStore(client);

    const updated = await store.update(id, "org-a", { expiresAt: null });

    expect(updated.expiresAt).toBeNull();
    expect(calls[0]?.sql).toContain("expires_at = $3");
    expect(calls[0]?.values).toEqual([id, "org-a", null]);
  });

  it("selects only expired records outside legal hold for bounded retention maintenance", async () => {
    let sql = "";
    let values: unknown[] = [];
    const store = new PostgresMemoryStore({ query: async (statement, receivedValues = []) => {
      sql = statement;
      values = receivedValues;
      return { rows: [], rowCount: 0 };
    } });

    await store.listExpired(25, new Date("2026-08-15T00:00:00.000Z"));

    expect(sql).toContain("retention_policy <> 'legal_hold'");
    expect(sql).toContain("expires_at <= $1");
    expect(values).toEqual(["2026-08-15T00:00:00.000Z", 25]);
  });

  it("uses a fixed JSON entity/ticker predicate for research-memory leads", async () => {
    let sql = "";
    let values: unknown[] = [];
    const store = new PostgresMemoryStore({ query: async (statement, receivedValues = []) => {
      sql = statement;
      values = receivedValues;
      return { rows: [], rowCount: 0 };
    } });

    await store.retrieve({ tenantId: "org-a", scopes: ["research"], researchTerms: ["NVIDIA", "NVDA"] });

    expect(sql).toContain("metadata -> 'entities'");
    expect(sql).toContain("metadata -> 'tickers'");
    expect(values).toContainEqual(["NVIDIA", "NVDA"]);
  });

  it("does not generate an update when the patch is empty", async () => {
    const id = randomUUID();
    const calls: string[] = [];
    const client: SqlClient = {
      query: async (sql) => {
        calls.push(sql);
        return { rowCount: 1, rows: [{
          id, organization_id: "org-a", user_id: "user-a", conversation_id: null, scope: "long_term", visibility: "private",
          content: "DCF", source_run_id: null, expires_at: null, retention_policy: "user_managed", metadata: {},
        }] };
      },
    };

    await new PostgresMemoryStore(client).update(id, "org-a", {});

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^SELECT \*/);
  });
});
