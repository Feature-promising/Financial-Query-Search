import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { runDatabaseMigrations, type DatabaseMigrationClient, type DatabaseMigrationPool, type MigrationFileStore } from "../src/index.js";

describe("database migrations", () => {
  it("preserves legacy preference history before enforcing one active key per user", async () => {
    const migration = await readFile(new URL("../migrations/0008_confirmed_preference_uniqueness.sql", import.meta.url), "utf8");
    expect(migration).toContain("ADD COLUMN preference_key");
    expect(migration).toContain("row_number() OVER");
    expect(migration).toContain("CREATE UNIQUE INDEX memory_active_preference_idx");
    expect(migration).toContain("userConfirmed}', 'false'");
  });

  it("adds tenant-bound foreign keys for every organization-scoped research artifact", async () => {
    const migration = await readFile(new URL("../migrations/0009_tenant_relational_integrity.sql", import.meta.url), "utf8");
    for (const constraint of [
      "conversations_owner_organization_fkey",
      "research_runs_conversation_organization_fkey",
      "evidence_items_run_organization_fkey",
      "tool_invocations_run_organization_fkey",
      "model_invocations_run_organization_fkey",
      "research_run_checkpoints_run_organization_fkey",
      "research_reports_run_organization_fkey",
      "research_run_evidence_evidence_organization_fkey",
    ]) expect(migration).toContain(constraint);
    expect(migration).toContain("ADD COLUMN organization_id uuid");
    expect(migration).toContain("ALTER COLUMN organization_id SET NOT NULL");
  });

  it("backfills and directly scopes messages, run events, and run-command outbox records", async () => {
    const migration = await readFile(new URL("../migrations/0010_direct_tenant_keys.sql", import.meta.url), "utf8");
    for (const table of ["messages", "run_events", "outbox_events"]) {
      expect(migration).toContain(`ALTER TABLE ${table}`);
      expect(migration).toContain("ADD COLUMN organization_id uuid");
    }
    expect(migration).toContain("messages_conversation_organization_fkey");
    expect(migration).toContain("run_events_run_organization_fkey");
    expect(migration).toContain("outbox_events_organization_fkey");
    expect(migration).toContain("WHERE event.event_type = 'research_run_requested'");
  });

  it("adds reversible archive and auditable tombstone lifecycle fields to conversations", async () => {
    const migration = await readFile(new URL("../migrations/0011_conversation_lifecycle.sql", import.meta.url), "utf8");
    for (const field of ["archived_at", "deleted_at", "deleted_by"]) expect(migration).toContain(field);
    expect(migration).toContain("conversations_deleted_by_organization_fkey");
    expect(migration).toContain("conversations_deleted_state_check");
    expect(migration).toContain("conversations_active_visible_idx");
  });

  it("adds a queued-only paused status without widening running execution semantics", async () => {
    const migration = await readFile(new URL("../migrations/0012_queued_run_controls.sql", import.meta.url), "utf8");
    expect(migration).toContain("DROP CONSTRAINT research_runs_status_check");
    expect(migration).toContain("'paused'");
    expect(migration).toContain("research_runs_paused_idx");
  });

  it("indexes visible conversations for tenant-scoped keyset pagination", async () => {
    const migration = await readFile(new URL("../migrations/0013_conversation_page_cursor.sql", import.meta.url), "utf8");
    expect(migration).toContain("conversations_visible_page_idx");
    expect(migration).toContain("organization_id, archived_at, updated_at DESC, id DESC");
    expect(migration).toContain("WHERE deleted_at IS NULL");
  });

  it("serializes, records, and then skips immutable ordered migrations", async () => {
    const client = new FakeMigrationClient();
    const pool: DatabaseMigrationPool = { connect: async () => client };
    const files = fixtureStore();

    expect(await runDatabaseMigrations(pool, files)).toMatchObject({ applied: ["0000_initial.sql", "0001_evidence.sql"], alreadyApplied: [] });
    expect(await runDatabaseMigrations(pool, files)).toMatchObject({ applied: [], alreadyApplied: ["0000_initial.sql", "0001_evidence.sql"] });
    expect(client.releases).toBe(2);
    expect(client.queries.filter((query) => query === "BEGIN")).toHaveLength(2);
    expect(client.queries.filter((query) => query === "COMMIT")).toHaveLength(2);
  });

  it("fails closed and rolls back if an applied migration changes", async () => {
    const client = new FakeMigrationClient([["0000_initial.sql", "incorrect-checksum"]]);
    const pool: DatabaseMigrationPool = { connect: async () => client };

    await expect(runDatabaseMigrations(pool, fixtureStore())).rejects.toThrow("migration checksum mismatch: 0000_initial.sql");
    expect(client.queries).toContain("ROLLBACK");
    expect(client.queries.at(-1)).toBe("SELECT pg_advisory_unlock($1)");
  });

  it("rejects an unordered migration source before it mutates schema state", async () => {
    const client = new FakeMigrationClient();
    const pool: DatabaseMigrationPool = { connect: async () => client };
    const unordered: MigrationFileStore = { list: async () => [
      { name: "0001_evidence.sql", sql: "SELECT 2" },
      { name: "0000_initial.sql", sql: "SELECT 1" },
    ] };

    await expect(runDatabaseMigrations(pool, unordered)).rejects.toThrow("migration files must be strictly ordered by name");
    expect(client.queries).not.toContain("BEGIN");
  });
});

function fixtureStore(): MigrationFileStore {
  return { list: async () => [
    { name: "0000_initial.sql", sql: "SELECT 1" },
    { name: "0001_evidence.sql", sql: "SELECT 2" },
  ] };
}

class FakeMigrationClient implements DatabaseMigrationClient {
  readonly queries: string[] = [];
  releases = 0;
  private readonly applied: Map<string, string>;

  constructor(applied: Array<[string, string]> = []) {
    this.applied = new Map(applied);
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push(sql);
    if (sql.startsWith("SELECT name, checksum")) {
      return { rows: [...this.applied].map(([name, checksum]) => ({ name, checksum }) as T) };
    }
    if (sql.startsWith("INSERT INTO schema_migrations")) {
      this.applied.set(String(values?.[0]), String(values?.[1]));
    }
    return { rows: [] };
  }

  release(): void { this.releases += 1; }
}
