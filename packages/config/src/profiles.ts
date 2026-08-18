import { assertProductionAllowedOrigins, parseAllowedOrigins } from "./cors.js";
import { EnvironmentSchema, type AppConfig } from "./schema.js";

export interface MigrationConfig {
  NODE_ENV: AppConfig["NODE_ENV"];
  PERSISTENCE_MODE: "postgres";
  DATABASE_URL: string;
}

const MigrationConfigSchema = EnvironmentSchema.pick({ NODE_ENV: true, PERSISTENCE_MODE: true, DATABASE_URL: true });

/** Legacy full-platform loader. Runtime entry points must use a narrower profile below. */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = EnvironmentSchema.parse(environment);
  const allowedOrigins = parseAllowedOrigins(config.CORS_ALLOWED_ORIGINS);
  if (config.NODE_ENV === "production") {
    if (config.PERSISTENCE_MODE !== "postgres" || !config.DATABASE_URL || !config.REDIS_URL || !config.SQS_RESEARCH_RUN_QUEUE_URL || !config.BEDROCK_MODEL_ID || !config.BEDROCK_EMBEDDING_MODEL_ID || config.BEDROCK_INPUT_COST_PER_1K_USD == null || config.BEDROCK_OUTPUT_COST_PER_1K_USD == null || config.BEDROCK_EMBEDDING_INPUT_COST_PER_1K_USD == null || !config.OPENSEARCH_ENDPOINT || !config.OPENSEARCH_INDEX || !config.EVIDENCE_S3_BUCKET || !config.REDSHIFT_WORKGROUP || !config.REDSHIFT_DATABASE || !config.REDSHIFT_SECRET_ARN || !config.MARKET_DATA_LICENSE || !config.NEO4J_URI || !config.NEO4J_USERNAME || !config.NEO4J_PASSWORD || !config.OIDC_ISSUER || !config.OIDC_AUDIENCE || !config.SEC_USER_AGENT || !config.TOOL_MANIFEST_CATALOG_JSON) {
      throw new Error("production requires database, redis, SQS, Bedrock, OpenSearch, evidence S3, Redshift, Neo4j, licensed market data, and OIDC configuration");
    }
    assertProductionAllowedOrigins(allowedOrigins);
  }
  return config;
}

/** API requires identity, durable submission, and the evidence-cleanup path, but never financial-warehouse credentials. */
export function loadApiConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = EnvironmentSchema.parse(environment);
  if (config.NODE_ENV === "production") {
    if (!hasApiDependencies(config)) throw new Error("production API requires persistence, live events, OIDC, approved tools, and evidence-cleanup configuration");
    assertProductionAllowedOrigins(parseAllowedOrigins(config.CORS_ALLOWED_ORIGINS));
  }
  return config;
}

/** Agent Worker owns model, tool, retrieval, and warehouse execution; it has no OIDC or browser-origin dependency. */
export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = EnvironmentSchema.parse(environment);
  if (config.NODE_ENV === "production" && !hasWorkerDependencies(config)) throw new Error("production worker requires persistence, queue, models, evidence, warehouse, graph, and approved-tool configuration");
  return config;
}

/** Scheduled SEC ingestion receives only its source-ingestion and evidence-index dependencies. */
export function loadSecIngestionConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = EnvironmentSchema.parse(environment);
  if (config.NODE_ENV === "production" && !hasSecIngestionDependencies(config)) throw new Error("production SEC ingestion requires persistence, SEC source, embedding, evidence-index, graph, and target configuration");
  return config;
}

/** Scheduled retention receives only the artifacts required to perform auditable cross-store deletion. */
export function loadMemoryRetentionConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = EnvironmentSchema.parse(environment);
  if (config.NODE_ENV === "production" && !hasMemoryRetentionDependencies(config)) throw new Error("production memory retention requires persistence, embedding, evidence-index, and graph configuration");
  return config;
}

/** One-shot migration accepts only its database runtime contract. */
export function loadMigrationConfig(environment: NodeJS.ProcessEnv = process.env): MigrationConfig {
  const config = MigrationConfigSchema.parse(environment);
  if (config.PERSISTENCE_MODE !== "postgres" || !config.DATABASE_URL) throw new Error("database migrations require PERSISTENCE_MODE=postgres and DATABASE_URL");
  return { NODE_ENV: config.NODE_ENV, PERSISTENCE_MODE: config.PERSISTENCE_MODE, DATABASE_URL: config.DATABASE_URL };
}

function hasApiDependencies(config: AppConfig): boolean {
  return config.PERSISTENCE_MODE === "postgres" && Boolean(config.DATABASE_URL && config.REDIS_URL && config.SQS_RESEARCH_RUN_QUEUE_URL && config.BEDROCK_EMBEDDING_MODEL_ID && config.OPENSEARCH_ENDPOINT && config.OPENSEARCH_INDEX && config.EVIDENCE_S3_BUCKET && config.NEO4J_URI && config.NEO4J_USERNAME && config.NEO4J_PASSWORD && config.OIDC_ISSUER && config.OIDC_AUDIENCE && config.TOOL_MANIFEST_CATALOG_JSON);
}

function hasWorkerDependencies(config: AppConfig): boolean {
  return config.PERSISTENCE_MODE === "postgres" && Boolean(config.DATABASE_URL && config.REDIS_URL && config.SQS_RESEARCH_RUN_QUEUE_URL && config.EVENTBRIDGE_EVENT_BUS_NAME && config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT && config.BEDROCK_MODEL_ID && config.BEDROCK_EMBEDDING_MODEL_ID && config.BEDROCK_INPUT_COST_PER_1K_USD != null && config.BEDROCK_OUTPUT_COST_PER_1K_USD != null && config.BEDROCK_EMBEDDING_INPUT_COST_PER_1K_USD != null && config.OPENSEARCH_ENDPOINT && config.OPENSEARCH_INDEX && config.EVIDENCE_S3_BUCKET && config.REDSHIFT_WORKGROUP && config.REDSHIFT_DATABASE && config.REDSHIFT_SECRET_ARN && config.MARKET_DATA_LICENSE && config.NEO4J_URI && config.NEO4J_USERNAME && config.NEO4J_PASSWORD && config.SEC_USER_AGENT && config.TOOL_MANIFEST_CATALOG_JSON);
}

function hasSecIngestionDependencies(config: AppConfig): boolean {
  return config.PERSISTENCE_MODE === "postgres" && Boolean(config.DATABASE_URL && config.SEC_USER_AGENT && config.BEDROCK_EMBEDDING_MODEL_ID && config.OPENSEARCH_ENDPOINT && config.OPENSEARCH_INDEX && config.EVIDENCE_S3_BUCKET && config.NEO4J_URI && config.NEO4J_USERNAME && config.NEO4J_PASSWORD && config.SEC_INGEST_TENANT_ID && config.SEC_INGEST_TICKERS);
}

function hasMemoryRetentionDependencies(config: AppConfig): boolean {
  return config.PERSISTENCE_MODE === "postgres" && Boolean(config.DATABASE_URL && config.BEDROCK_EMBEDDING_MODEL_ID && config.OPENSEARCH_ENDPOINT && config.OPENSEARCH_INDEX && config.EVIDENCE_S3_BUCKET && config.NEO4J_URI && config.NEO4J_USERNAME && config.NEO4J_PASSWORD);
}
