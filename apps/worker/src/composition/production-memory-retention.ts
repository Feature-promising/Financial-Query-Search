import type { AppConfig } from "@research/config";
import { createDatabase, PostgresMemoryDeletionAuditSink } from "@research/db";
import { EvidenceDeletionCoordinator, AwsOpenSearchTransport, Neo4jDriverClient, Neo4jKnowledgeGraph, OpenSearchVectorIndex, S3EvidenceLake } from "@research/knowledge";
import { BedrockEmbeddingModel } from "@research/models";
import { CoordinatedMemoryStore, MemoryRetentionService, PostgresMemoryStore } from "@research/memory";

export interface ProductionMemoryRetention {
  purgeExpired(): Promise<{ scanned: number; deleted: number; failed: number }>;
  close(): Promise<void>;
}

/** Separate scheduled-maintenance composition; no conversation or Agent runtime is loaded. */
export function createProductionMemoryRetention(config: AppConfig): ProductionMemoryRetention {
  if (config.PERSISTENCE_MODE !== "postgres" || !config.DATABASE_URL || !config.BEDROCK_EMBEDDING_MODEL_ID || !config.OPENSEARCH_ENDPOINT || !config.OPENSEARCH_INDEX || !config.EVIDENCE_S3_BUCKET || !config.NEO4J_URI || !config.NEO4J_USERNAME || !config.NEO4J_PASSWORD) {
    throw new Error("memory retention requires PostgreSQL, Bedrock embedding, OpenSearch, evidence S3, and Neo4j configuration");
  }
  const { pool } = createDatabase(config.DATABASE_URL);
  const client = pool as never;
  const embedding = new BedrockEmbeddingModel({ region: config.AWS_REGION, modelId: config.BEDROCK_EMBEDDING_MODEL_ID, inputCostPer1kUsd: config.BEDROCK_EMBEDDING_INPUT_COST_PER_1K_USD });
  const index = new OpenSearchVectorIndex(new AwsOpenSearchTransport({ endpoint: config.OPENSEARCH_ENDPOINT, region: config.AWS_REGION }), config.OPENSEARCH_INDEX, embedding);
  const graphClient = new Neo4jDriverClient({ uri: config.NEO4J_URI, username: config.NEO4J_USERNAME, password: config.NEO4J_PASSWORD });
  const memories = new CoordinatedMemoryStore(
    new PostgresMemoryStore(client),
    new EvidenceDeletionCoordinator({ index, graph: new Neo4jKnowledgeGraph(graphClient), lake: new S3EvidenceLake({ bucket: config.EVIDENCE_S3_BUCKET, region: config.AWS_REGION, prefix: config.EVIDENCE_S3_PREFIX }) }),
    new PostgresMemoryDeletionAuditSink(client),
  );
  const retention = new MemoryRetentionService(memories, memories);
  return {
    purgeExpired: () => retention.purgeExpired(config.MEMORY_RETENTION_BATCH_SIZE),
    async close() { await Promise.all([graphClient.close(), pool.end()]); },
  };
}
