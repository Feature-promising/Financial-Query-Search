import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const migrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const migrationLockKey = 8_620_341_991;

export interface DatabaseMigrationClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

export interface DatabaseMigrationPool {
  connect(): Promise<DatabaseMigrationClient>;
}

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface MigrationFileStore {
  list(): Promise<MigrationFile[]>;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Reads only ordered, immutable migration files. The repository path is passed
 * explicitly so deployment code never relies on a package-manager layout.
 */
export function fileSystemMigrationStore(directory: string): MigrationFileStore {
  return {
    async list(): Promise<MigrationFile[]> {
      const names = (await readdir(directory)).filter((name) => migrationFilePattern.test(name)).sort();
      return Promise.all(names.map(async (name) => ({ name, sql: await readFile(resolve(directory, name), "utf8") })));
    },
  };
}

/**
 * Applies each migration exactly once under a database-wide advisory lock.
 * A changed file checksum fails closed rather than silently altering an
 * already-audited schema transition.
 */
export async function runDatabaseMigrations(pool: DatabaseMigrationPool, files: MigrationFileStore): Promise<MigrationResult> {
  const migrations = await files.list();
  assertMigrationOrder(migrations);
  const client = await pool.connect();
  let locked = false;
  let transactionStarted = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [migrationLockKey]);
    locked = true;
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name varchar(255) PRIMARY KEY,
      checksum varchar(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const appliedRows = await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations ORDER BY name");
    const appliedByName = new Map(appliedRows.rows.map((row) => [row.name, row.checksum]));
    const result: MigrationResult = { applied: [], alreadyApplied: [] };

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration.sql);
      const recordedChecksum = appliedByName.get(migration.name);
      if (recordedChecksum) {
        if (recordedChecksum !== checksum) throw new Error(`migration checksum mismatch: ${migration.name}`);
        result.alreadyApplied.push(migration.name);
        continue;
      }
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [migration.name, checksum]);
      result.applied.push(migration.name);
    }
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    throw error;
  } finally {
    try { if (locked) await client.query("SELECT pg_advisory_unlock($1)", [migrationLockKey]); }
    finally { client.release(); }
  }
}

function assertMigrationOrder(migrations: MigrationFile[]): void {
  const names = new Set<string>();
  let previousName: string | undefined;
  for (const migration of migrations) {
    if (!migrationFilePattern.test(migration.name)) throw new Error(`invalid migration filename: ${migration.name}`);
    if (names.has(migration.name)) throw new Error(`duplicate migration filename: ${migration.name}`);
    if (previousName && migration.name <= previousName) throw new Error("migration files must be strictly ordered by name");
    names.add(migration.name);
    previousName = migration.name;
  }
}

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}
