import { describe, expect, it } from "vitest";
import { loadConfig } from "@research/config";
import { createProductionWorker } from "../src/composition/production-worker.js";

describe("createProductionWorker", () => {
  it("fails closed when production tracing has no explicit OTLP collector", () => {
    const config = loadConfig({ ...productionEnvironment(), OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: undefined });

    expect(() => createProductionWorker(config)).toThrow("OTLP trace endpoint");
  });

  it("fails closed when lifecycle EventBridge publication is not configured", () => {
    const config = loadConfig({ ...productionEnvironment(), EVENTBRIDGE_EVENT_BUS_NAME: undefined });

    expect(() => createProductionWorker(config)).toThrow("EventBridge");
  });

  it("rejects a malformed catalog before opening production adapters", () => {
    const config = loadConfig({ ...productionEnvironment(), TOOL_MANIFEST_CATALOG_JSON: "not-json" });
    expect(() => createProductionWorker(config)).toThrow("valid JSON");
  });
});

function productionEnvironment() {
  return {
    NODE_ENV: "production" as const,
    PERSISTENCE_MODE: "postgres" as const,
    DATABASE_URL: "postgresql://research:password@database.internal/research",
    REDIS_URL: "redis://redis.internal:6379",
    SQS_RESEARCH_RUN_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/research-runs",
    EVENTBRIDGE_EVENT_BUS_NAME: "research-domain-events",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.internal/v1/traces",
    BEDROCK_MODEL_ID: "model-id",
    BEDROCK_EMBEDDING_MODEL_ID: "embedding-id",
    BEDROCK_INPUT_COST_PER_1K_USD: "0.001",
    BEDROCK_OUTPUT_COST_PER_1K_USD: "0.002",
    BEDROCK_EMBEDDING_INPUT_COST_PER_1K_USD: "0.0001",
    OPENSEARCH_ENDPOINT: "https://search.internal",
    OPENSEARCH_INDEX: "evidence-v1",
    EVIDENCE_S3_BUCKET: "research-evidence",
    REDSHIFT_WORKGROUP: "research-workgroup",
    REDSHIFT_DATABASE: "research",
    REDSHIFT_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:research-redshift",
    MARKET_DATA_LICENSE: "licensed-provider",
    SEC_USER_AGENT: "Research Agent test@example.com",
    NEO4J_URI: "neo4j+s://graph.internal",
    NEO4J_USERNAME: "research",
    NEO4J_PASSWORD: "password",
    OIDC_ISSUER: "https://identity.internal",
    OIDC_AUDIENCE: "research-api",
    CORS_ALLOWED_ORIGINS: "https://research.internal",
    TOOL_MANIFEST_CATALOG_JSON: toolCatalogJson(),
  };
}

function toolCatalogJson(): string {
  return JSON.stringify([
    { id: "filing.search", version: "sec-edgar-v1", capability: "sec_filing_retrieval", requiredEntitlements: [], timeoutMs: 20_000, enabled: true },
    { id: "financial.get", version: "warehouse-v1", capability: "licensed_financial_data", requiredEntitlements: ["market-data"], timeoutMs: 20_000, enabled: true },
    { id: "retrieval.search", version: "hybrid-v1", capability: "hybrid_retrieval", requiredEntitlements: [], timeoutMs: 20_000, enabled: true },
    { id: "graph.query", version: "graph-v1", capability: "knowledge_graph_read", requiredEntitlements: ["graph-read"], timeoutMs: 10_000, enabled: true },
    { id: "analysis.dcf", version: "dcf-v1", capability: "deterministic_valuation", requiredEntitlements: [], timeoutMs: 5_000, enabled: true },
  ]);
}
