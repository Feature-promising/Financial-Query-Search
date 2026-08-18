import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment, loadMigrationConfig } from "@research/config";
import { createDatabase, fileSystemMigrationStore, runDatabaseMigrations } from "@research/db";

loadLocalEnvironment();
const config = loadMigrationConfig();

const { pool } = createDatabase(config.DATABASE_URL);
try {
  const dbPackageDirectory = resolve(dirname(fileURLToPath(import.meta.resolve("@research/db"))), "..");
  const result = await runDatabaseMigrations(pool, fileSystemMigrationStore(resolve(dbPackageDirectory, "migrations")));
  process.stdout.write(`Database migrations complete: applied=${result.applied.join(",") || "none"}; already_applied=${result.alreadyApplied.join(",") || "none"}\n`);
} finally {
  await pool.end();
}
