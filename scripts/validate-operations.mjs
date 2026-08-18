import { readFile } from "node:fs/promises";

const runbook = await readFile(new URL("../docs/operations/production-runbook.md", import.meta.url), "utf8");
for (const required of [
  "RPO ≤ 24 hours",
  "RTO ≤ 4 hours",
  "domain_event_outbox",
  "schema_migrations",
  "TOOL_MANIFEST_CATALOG_JSON",
  "check:runtime-profiles",
  "migration_secrets",
  "never automatically replayed",
  "Quarterly",
  "Data licensing, security, and drills",
  "events:PutEvents",
]) {
  if (!runbook.includes(required)) throw new Error(`production runbook is missing required control: ${required}`);
}
const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
for (const required of [
  "postgres-integration:",
  "image: postgres:16-alpine",
  "pnpm --filter @research/worker migrate",
  "pnpm --filter @research/db exec node scripts/verify-publication.mjs",
]) {
  if (!ci.includes(required)) throw new Error(`CI is missing PostgreSQL integration control: ${required}`);
}
const matrix = await readFile(new URL("../docs/architecture/implementation-matrix.md", import.meta.url), "utf8");
for (const required of [
  "管理员审批的外部工具目录",
  "TOOL_MANIFEST_CATALOG_JSON",
  "发布前外部验收清单",
  "数据许可",
  "真实 PostgreSQL 验证",
]) {
  if (!matrix.includes(required)) throw new Error(`implementation matrix is missing required release boundary: ${required}`);
}
console.log("Production operations runbook validated");
