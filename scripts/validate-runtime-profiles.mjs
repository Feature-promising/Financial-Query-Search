import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

const [api, worker, ingestion, retention, migration, profiles, tasks] = await Promise.all([
  source("apps/api/src/server.ts"),
  source("apps/worker/src/main.ts"),
  source("apps/worker/src/sec-ingestion-main.ts"),
  source("apps/worker/src/memory-retention-main.ts"),
  source("apps/worker/src/migrate-main.ts"),
  source("packages/config/src/profiles.ts"),
  source("infra/terraform/tasks.tf"),
]);

for (const [label, content, loader] of [
  ["API", api, "loadApiConfig"],
  ["Agent Worker", worker, "loadWorkerConfig"],
  ["SEC ingestion", ingestion, "loadSecIngestionConfig"],
  ["memory retention", retention, "loadMemoryRetentionConfig"],
  ["database migration", migration, "loadMigrationConfig"],
]) {
  if (!content.includes(`${loader}()`)) throw new Error(`${label} must load its dedicated production configuration profile`);
}

for (const loader of ["loadApiConfig", "loadWorkerConfig", "loadSecIngestionConfig", "loadMemoryRetentionConfig", "loadMigrationConfig"]) {
  if (!profiles.includes(`function ${loader}`)) throw new Error(`configuration profile module is missing ${loader}`);
}

for (const scopedMap of ["api_secrets", "worker_secrets", "sec_ingestion_secrets", "memory_retention_secrets", "migration_secrets"]) {
  if (!tasks.includes(`var.${scopedMap}`)) throw new Error(`Terraform must inject the scoped ${scopedMap} map`);
}

for (const inheritedContainer of ["sec_ingestion_container = merge(local.worker_container", "memory_retention_container = merge(local.worker_container", "migration_container = merge(local.worker_container"]) {
  if (tasks.includes(inheritedContainer)) throw new Error("scheduled or migration task must not inherit the Agent Worker container contract");
}

console.log("Runtime configuration-profile contract validated");
