import { loadLocalEnvironment, loadMemoryRetentionConfig } from "@research/config";
import { createProductionMemoryRetention } from "./composition/production-memory-retention.js";

loadLocalEnvironment();
const retention = createProductionMemoryRetention(loadMemoryRetentionConfig());
try {
  const result = await retention.purgeExpired();
  // Aggregate-only output: no memory content or IDs enter task logs.
  process.stdout.write(`Memory retention completed: scanned=${result.scanned} deleted=${result.deleted} failed=${result.failed}\n`);
} finally {
  await retention.close();
}
