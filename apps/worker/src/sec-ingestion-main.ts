import { loadLocalEnvironment, loadSecIngestionConfig } from "@research/config";
import { createProductionSecIngestion } from "./composition/production-sec-ingestion.js";

loadLocalEnvironment();
const config = loadSecIngestionConfig();
const tenantId = config.SEC_INGEST_TENANT_ID;
const tickers = (config.SEC_INGEST_TICKERS ?? "").split(",").map((ticker) => ticker.trim().toUpperCase()).filter((ticker) => /^[A-Z.]{1,10}$/.test(ticker));
if (!tenantId || !tickers.length) throw new Error("SEC_INGEST_TENANT_ID and SEC_INGEST_TICKERS are required for scheduled ingestion");
const ingestion = createProductionSecIngestion(config);
try {
  const result = await ingestion.ingest([...new Set(tickers)].slice(0, 100), tenantId);
  process.stdout.write(`${JSON.stringify({ event: "sec_ingestion_finished", ...result })}\n`);
  // The aggregate lifecycle event is already durable in the outbox. A partial
  // failure must still mark the Fargate task unhealthy so platform alarms and
  // the next scheduled retry are not hidden by successful tickers.
  if (result.failedTickerCount > 0) process.exitCode = 1;
} finally {
  await ingestion.close();
}
