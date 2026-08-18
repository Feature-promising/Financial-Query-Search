import type { EvidenceItem } from "@research/contracts";

export interface SecTickerIngestor {
  ingest(ticker: string, tenantId: string): Promise<EvidenceItem | undefined>;
}

/** Content-free outcome used for lifecycle events and scheduled-task health. */
export interface SecIngestionBatchResult {
  requestedTickerCount: number;
  ingestedEvidenceCount: number;
  failedTickerCount: number;
}

/**
 * Continues independent ticker ingestion after a provider or parser failure.
 * It intentionally returns only aggregate counts: raw ticker/error detail
 * belongs in protected task diagnostics, never EventBridge or task output.
 */
export async function ingestSecFilingBatch(ingestor: SecTickerIngestor, tickers: string[], tenantId: string): Promise<SecIngestionBatchResult> {
  const uniqueTickers = [...new Set(tickers)];
  if (uniqueTickers.length < 1 || uniqueTickers.length > 100) throw new Error("SEC ingestion batch must contain between 1 and 100 tickers");
  const results = await Promise.allSettled(uniqueTickers.map((ticker) => ingestor.ingest(ticker, tenantId)));
  return {
    requestedTickerCount: uniqueTickers.length,
    ingestedEvidenceCount: results.filter((result): result is PromiseFulfilledResult<EvidenceItem | undefined> => result.status === "fulfilled").filter((result) => result.value !== undefined).length,
    failedTickerCount: results.filter((result) => result.status === "rejected").length,
  };
}
