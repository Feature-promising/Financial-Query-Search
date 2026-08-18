import { randomUUID } from "node:crypto";
import type { AppConfig } from "@research/config";
import { DomainEventSchema } from "@research/contracts";
import { createDatabase, PostgresDomainEventOutboxStore } from "@research/db";
import { AwsOpenSearchTransport, EvidenceIngestionService, Neo4jDriverClient, Neo4jKnowledgeGraph, OpenSearchVectorIndex, S3EvidenceLake } from "@research/knowledge";
import { BedrockEmbeddingModel } from "@research/models";
import { SecEdgarClient } from "@research/tools";
import { SecFilingIngestionService } from "../ingestion/sec-filing-ingestion.js";
import { ingestSecFilingBatch, type SecIngestionBatchResult } from "../ingestion/sec-ingestion-batch.js";

export interface ProductionSecIngestion {
  ingest(tickers: string[], tenantId: string): Promise<SecIngestionBatchResult>;
  close(): Promise<void>;
}

/** Separate scheduled-ingestion composition; it has no API, queue, or chat state. */
export function createProductionSecIngestion(config: AppConfig): ProductionSecIngestion {
  if (!config.DATABASE_URL || !config.SEC_USER_AGENT || !config.BEDROCK_EMBEDDING_MODEL_ID || !config.OPENSEARCH_ENDPOINT || !config.OPENSEARCH_INDEX || !config.EVIDENCE_S3_BUCKET || !config.NEO4J_URI || !config.NEO4J_USERNAME || !config.NEO4J_PASSWORD) {
    throw new Error("SEC ingestion requires PostgreSQL, SEC user agent, Bedrock embedding, OpenSearch, evidence S3, and Neo4j configuration");
  }
  const embedding = new BedrockEmbeddingModel({ region: config.AWS_REGION, modelId: config.BEDROCK_EMBEDDING_MODEL_ID, inputCostPer1kUsd: config.BEDROCK_EMBEDDING_INPUT_COST_PER_1K_USD });
  const index = new OpenSearchVectorIndex(new AwsOpenSearchTransport({ endpoint: config.OPENSEARCH_ENDPOINT, region: config.AWS_REGION }), config.OPENSEARCH_INDEX, embedding);
  const graphClient = new Neo4jDriverClient({ uri: config.NEO4J_URI, username: config.NEO4J_USERNAME, password: config.NEO4J_PASSWORD });
  const graph = new Neo4jKnowledgeGraph(graphClient);
  const repository = new EvidenceIngestionService(new S3EvidenceLake({ bucket: config.EVIDENCE_S3_BUCKET, region: config.AWS_REGION, prefix: config.EVIDENCE_S3_PREFIX }), index, graph);
  const service = new SecFilingIngestionService(new SecEdgarClient({ userAgent: config.SEC_USER_AGENT, maxResponseBytes: config.SEC_MAX_RESPONSE_BYTES }), repository);
  const { pool } = createDatabase(config.DATABASE_URL);
  const outbox = new PostgresDomainEventOutboxStore(pool as never);
  return {
    async ingest(tickers, tenantId) {
      const result = await ingestSecFilingBatch(service, tickers, tenantId);
      await outbox.enqueue(DomainEventSchema.parse({
        id: randomUUID(),
        type: "knowledge.sec_ingestion.completed",
        tenantId,
        aggregateId: randomUUID(),
        occurredAt: new Date().toISOString(),
        data: result,
      }));
      return result;
    },
    async close() { await Promise.all([graphClient.close(), pool.end()]); },
  };
}
