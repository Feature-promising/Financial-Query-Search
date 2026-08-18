import { loadLocalEnvironment, loadWorkerConfig } from "@research/config";
import { createProductionWorker } from "./composition/production-worker.js";

loadLocalEnvironment();
const config = loadWorkerConfig();
const worker = createProductionWorker(config);
const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort());
}

try {
  await worker.runUntilAborted(controller.signal);
} finally {
  await worker.close();
}
