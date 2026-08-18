import type { AppConfig } from "@research/config";
import { InMemoryConversationStore, PostgresConversationStore, type ConversationStore } from "@research/conversation";
import { createDatabase, PostgresEvidenceStore, PostgresMemoryDeletionAuditSink, PostgresPrincipalProvisioner, PostgresRunSubmissionStore, type PrincipalProvisioner, type RunSubmissionStore } from "@research/db";
import { InMemoryStore, PostgresMemoryStore, type MemoryStore } from "@research/memory";
import { CoordinatedMemoryStore } from "@research/memory";
import { InMemoryRunStore, PostgresRunStore, type RunStore } from "@research/runs";
import { InMemoryReportStore, PostgresReportStore, type ReportStore } from "@research/reports";
import { AwsOpenSearchTransport, EvidenceDeletionCoordinator, InMemoryEvidenceStore, Neo4jDriverClient, Neo4jKnowledgeGraph, OpenSearchVectorIndex, S3EvidenceLake, type EvidenceStore } from "@research/knowledge";
import { BedrockEmbeddingModel } from "@research/models";
import { PostgresReadinessProbe } from "./readiness.js";
import type { ReadinessProbe } from "../readiness.js";

export interface StoreDependencies {
  conversations: ConversationStore;
  memories: MemoryStore;
  runs: RunStore;
  reports: ReportStore;
  evidence: EvidenceStore;
  readiness?: ReadinessProbe;
  submissions?: RunSubmissionStore;
  provisioner?: PrincipalProvisioner;
  close(): Promise<void>;
}

export function createStores(config: AppConfig): StoreDependencies {
  if (config.PERSISTENCE_MODE === "memory") return { conversations: new InMemoryConversationStore(), memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), evidence: new InMemoryEvidenceStore(), close: async () => undefined };
  if (!config.DATABASE_URL) throw new Error("postgres persistence requires DATABASE_URL");
  const { pool } = createDatabase(config.DATABASE_URL);
  const client = pool as never;
  const baseMemories = new PostgresMemoryStore(client);
  const deletionDependencies = createDeletionDependencies(config);
  const memories = deletionDependencies ? new CoordinatedMemoryStore(baseMemories, deletionDependencies.coordinator, new PostgresMemoryDeletionAuditSink(client)) : baseMemories;
  return {
    conversations: new PostgresConversationStore(client), memories, runs: new PostgresRunStore(client), reports: new PostgresReportStore(client), evidence: new PostgresEvidenceStore(client), submissions: new PostgresRunSubmissionStore(client), provisioner: new PostgresPrincipalProvisioner(client), readiness: new PostgresReadinessProbe(client),
    close: async () => { await deletionDependencies?.close(); await pool.end(); },
  };
}

function createDeletionDependencies(config: AppConfig): { coordinator: EvidenceDeletionCoordinator; close(): Promise<void> } | undefined {
  if (!config.BEDROCK_EMBEDDING_MODEL_ID || !config.OPENSEARCH_ENDPOINT || !config.OPENSEARCH_INDEX || !config.EVIDENCE_S3_BUCKET || !config.NEO4J_URI || !config.NEO4J_USERNAME || !config.NEO4J_PASSWORD) return undefined;
  const embedding = new BedrockEmbeddingModel({ region: config.AWS_REGION, modelId: config.BEDROCK_EMBEDDING_MODEL_ID });
  const index = new OpenSearchVectorIndex(new AwsOpenSearchTransport({ endpoint: config.OPENSEARCH_ENDPOINT, region: config.AWS_REGION }), config.OPENSEARCH_INDEX, embedding);
  const graphClient = new Neo4jDriverClient({ uri: config.NEO4J_URI, username: config.NEO4J_USERNAME, password: config.NEO4J_PASSWORD });
  const graph = new Neo4jKnowledgeGraph(graphClient);
  const lake = new S3EvidenceLake({ bucket: config.EVIDENCE_S3_BUCKET, region: config.AWS_REGION, prefix: config.EVIDENCE_S3_PREFIX });
  return { coordinator: new EvidenceDeletionCoordinator({ index, graph, lake }), close: () => graphClient.close() };
}
