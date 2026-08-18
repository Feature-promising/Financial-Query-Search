import { ResearchRuntime } from "@research/agent-runtime";
import type { AppConfig } from "@research/config";
import { PostgresConversationStore } from "@research/conversation";
import { createDatabase, PostgresDomainEventOutboxStore, PostgresEvidenceStore, PostgresMemoryDeletionAuditSink, PostgresModelAuditSink, PostgresOutboxStore, PostgresResearchRunCommandResolver, PostgresResearchRunPublicationFinalizer, PostgresRunCheckpointSink } from "@research/db";
import { AwsOpenSearchTransport, EvidenceDeletionCoordinator, EvidenceIngestionService, HybridRetrievalPipeline, Neo4jDriverClient, Neo4jKnowledgeGraph, OpenSearchVectorIndex, RedshiftFinancialWarehouse, S3EvidenceLake } from "@research/knowledge";
import { CoordinatedMemoryStore, PostgresMemoryStore } from "@research/memory";
import { BedrockCitationEntailmentVerifier, BedrockEmbeddingModel, BedrockIntentAnalyzer, BedrockResearchPlanner, BedrockStructuredModel, EvidenceBoundClaimComposer } from "@research/models";
import { OpenTelemetryTraceSink, RateLimitedDomainEventOutboxHealthReporter, RunTracer, startOpenTelemetry } from "@research/observability";
import { RedisRunEventPublisher } from "@research/live-events";
import { ResearchRunOutboxPublisher, SqsQueue } from "@research/queue";
import { AwsEventBridgePublisher, DomainEventOutboxPublisher } from "@research/platform-events";
import { PostgresRunStore } from "@research/runs";
import { createDefaultToolRegistry, parseApprovedToolManifestCatalog, PostgresToolAuditSink } from "@research/tools";
import type { ResearchRunCommand } from "../commands/research-run.js";
import { DurableResearchRunHandler } from "../consumer/research-run-handler.js";
import { ResearchRunConsumer } from "../consumer/research-run-consumer.js";
import { PollingResearchWorker } from "../runtime/polling-worker.js";
import { runUntilAborted as runPollingUntilAborted } from "../runtime/run-loop.js";
import { RateLimitedDomainEventFailureReporter } from "../consumer/domain-event-failure-reporter.js";

export interface ProductionWorker {
  processOnce(signal?: AbortSignal): Promise<{ published: number; processed: number; lifecycleEventsPublished: number; outboxHealthReported: boolean }>;
  runUntilAborted(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/** Composes only production adapters; development remains in-process and fail-closed. */
export function createProductionWorker(config: AppConfig): ProductionWorker {
  if (config.PERSISTENCE_MODE !== "postgres" || !config.DATABASE_URL || !config.REDIS_URL || !config.SQS_RESEARCH_RUN_QUEUE_URL || !config.EVENTBRIDGE_EVENT_BUS_NAME || !config.BEDROCK_MODEL_ID || !config.BEDROCK_EMBEDDING_MODEL_ID || config.BEDROCK_INPUT_COST_PER_1K_USD == null || config.BEDROCK_OUTPUT_COST_PER_1K_USD == null || config.BEDROCK_EMBEDDING_INPUT_COST_PER_1K_USD == null || !config.OPENSEARCH_ENDPOINT || !config.OPENSEARCH_INDEX || !config.EVIDENCE_S3_BUCKET || !config.REDSHIFT_WORKGROUP || !config.REDSHIFT_DATABASE || !config.REDSHIFT_SECRET_ARN || !config.MARKET_DATA_LICENSE || !config.NEO4J_URI || !config.NEO4J_USERNAME || !config.NEO4J_PASSWORD || !config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || !config.SEC_USER_AGENT || !config.TOOL_MANIFEST_CATALOG_JSON) {
    throw new Error("production worker requires PostgreSQL, SQS, EventBridge, Bedrock pricing, OpenSearch, and an OTLP trace endpoint");
  }
  // Parse the secret before opening pools or telemetry exporters. A malformed
  // approval catalog is a deployment configuration error, not a recoverable
  // runtime fault, so startup must fail without acquiring external resources.
  const approvedToolManifests = parseApprovedToolManifestCatalog(config.TOOL_MANIFEST_CATALOG_JSON);
  const telemetry = startOpenTelemetry({ serviceName: "interactive-research-agent-worker", tracesEndpoint: config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT });
  const { pool } = createDatabase(config.DATABASE_URL);
  const client = pool as never;
  const conversations = new PostgresConversationStore(client);
  const runs = new PostgresRunStore(client);
  const modelAudit = new PostgresModelAuditSink(client);
  const model = new BedrockStructuredModel({ region: config.AWS_REGION, modelId: config.BEDROCK_MODEL_ID, inputCostPer1kUsd: config.BEDROCK_INPUT_COST_PER_1K_USD, outputCostPer1kUsd: config.BEDROCK_OUTPUT_COST_PER_1K_USD, audit: modelAudit });
  const embedding = new BedrockEmbeddingModel({ region: config.AWS_REGION, modelId: config.BEDROCK_EMBEDDING_MODEL_ID, inputCostPer1kUsd: config.BEDROCK_EMBEDDING_INPUT_COST_PER_1K_USD, audit: modelAudit });
  const evidenceIndex = new OpenSearchVectorIndex(new AwsOpenSearchTransport({ endpoint: config.OPENSEARCH_ENDPOINT, region: config.AWS_REGION }), config.OPENSEARCH_INDEX, embedding);
  const graphClient = new Neo4jDriverClient({ uri: config.NEO4J_URI, username: config.NEO4J_USERNAME, password: config.NEO4J_PASSWORD });
  const graph = new Neo4jKnowledgeGraph(graphClient);
  const retrievalPipeline = new HybridRetrievalPipeline(evidenceIndex, graph);
  const lake = new S3EvidenceLake({ bucket: config.EVIDENCE_S3_BUCKET, region: config.AWS_REGION, prefix: config.EVIDENCE_S3_PREFIX });
  const evidenceRepository = new EvidenceIngestionService(lake, evidenceIndex, graph);
  const memories = new CoordinatedMemoryStore(new PostgresMemoryStore(client), new EvidenceDeletionCoordinator({ index: evidenceIndex, graph, lake }), new PostgresMemoryDeletionAuditSink(client));
  const warehouse = new RedshiftFinancialWarehouse({ region: config.AWS_REGION, workgroupName: config.REDSHIFT_WORKGROUP, database: config.REDSHIFT_DATABASE, secretArn: config.REDSHIFT_SECRET_ARN });
  const liveEvents = new RedisRunEventPublisher({ url: config.REDIS_URL, streamKey: config.REDIS_RUN_EVENT_STREAM_KEY, maxLength: config.REDIS_RUN_EVENT_STREAM_MAX_LENGTH });
  const handler = new DurableResearchRunHandler({
    conversations,
    runs,
    evidence: new PostgresEvidenceStore(client),
    finalizer: new PostgresResearchRunPublicationFinalizer(client),
    checkpoints: new PostgresRunCheckpointSink(client),
    commandResolver: new PostgresResearchRunCommandResolver(client),
    liveEvents,
    runtime: {
      create: (events, command, costLedger) => new ResearchRuntime({
        events, memories, tools: createDefaultToolRegistry({ audit: new PostgresToolAuditSink(client), secUserAgent: config.SEC_USER_AGENT, secMaxResponseBytes: config.SEC_MAX_RESPONSE_BYTES, retrievalPipeline, financialWarehouse: warehouse, financialLicense: config.MARKET_DATA_LICENSE, graph, approvedManifests: approvedToolManifests }),
        intentAnalyzer: new BedrockIntentAnalyzer(model),
        planner: new BedrockResearchPlanner(model),
        evidenceRepository,
        checkpoints: new PostgresRunCheckpointSink(client),
        tracer: new RunTracer(new OpenTelemetryTraceSink(), command.runId),
        claimComposer: { compose: async (evidence, state, signal) => new EvidenceBoundClaimComposer(model).compose(state.run.question, evidence, state.run.scope, signal) },
        claimEntailmentVerifier: new BedrockCitationEntailmentVerifier(model),
        costLedger,
      }),
    },
  });
  const queue = new SqsQueue<ResearchRunCommand>({
    queueUrl: config.SQS_RESEARCH_RUN_QUEUE_URL,
    region: config.AWS_REGION,
    // A run is bounded to five minutes; the lease includes a shutdown margin.
    visibilityTimeoutSeconds: config.SQS_RESEARCH_RUN_VISIBILITY_TIMEOUT_SECONDS,
  });
  const publisher = new ResearchRunOutboxPublisher(new PostgresOutboxStore(client), queue);
  const worker = new PollingResearchWorker(queue, new ResearchRunConsumer(handler));
  const domainEventOutbox = new PostgresDomainEventOutboxStore(client);
  const lifecycleEvents = new DomainEventOutboxPublisher(
    domainEventOutbox,
    new AwsEventBridgePublisher({ region: config.AWS_REGION, eventBusName: config.EVENTBRIDGE_EVENT_BUS_NAME }),
  );
  const lifecycleEventFailures = new RateLimitedDomainEventFailureReporter();
  const outboxHealth = new RateLimitedDomainEventOutboxHealthReporter(domainEventOutbox);

  async function processOnce(signal?: AbortSignal): Promise<{ published: number; processed: number; lifecycleEventsPublished: number; outboxHealthReported: boolean }> {
    const published = await publisher.publishBatch();
    const processed = await worker.processOnce(signal);
    let lifecycleEventsPublished = 0;
    try { lifecycleEventsPublished = await lifecycleEvents.publishBatch(); }
    catch (error) { lifecycleEventFailures.report(error); }
    let outboxHealthReported = false;
    try { outboxHealthReported = await outboxHealth.reportIfDue(); }
    catch (error) { lifecycleEventFailures.report(error, "domain_event_outbox_health_failed"); }
    return { published, processed, lifecycleEventsPublished, outboxHealthReported };
  }

  return {
    processOnce,
    async runUntilAborted(signal) { await runPollingUntilAborted(signal, processOnce); },
    async close() { await Promise.all([telemetry.shutdown(), liveEvents.close(), graphClient.close(), pool.end()]); },
  };
}
