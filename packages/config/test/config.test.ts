import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadApiConfig, loadConfig, loadLocalEnvironment, loadMemoryRetentionConfig, loadMigrationConfig, loadSecIngestionConfig, loadWorkerConfig, parseLocalEnvironment } from "../src/index.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("rejects a production process configured with in-memory persistence", () => {
    expect(() => loadConfig({ NODE_ENV: "production", PERSISTENCE_MODE: "memory", DATABASE_URL: "postgres://localhost/db", REDIS_URL: "redis://localhost", SQS_RESEARCH_RUN_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/queue", BEDROCK_MODEL_ID: "model", BEDROCK_EMBEDDING_MODEL_ID: "embedding", BEDROCK_INPUT_COST_PER_1K_USD: "0.003", BEDROCK_OUTPUT_COST_PER_1K_USD: "0.015", OPENSEARCH_ENDPOINT: "https://search.example", OPENSEARCH_INDEX: "evidence-v1", EVIDENCE_S3_BUCKET: "research-evidence-bucket", REDSHIFT_WORKGROUP: "research", REDSHIFT_DATABASE: "warehouse", MARKET_DATA_LICENSE: "licensed", NEO4J_URI: "neo4j+s://graph.example", NEO4J_USERNAME: "neo4j", NEO4J_PASSWORD: "secret", OIDC_ISSUER: "https://issuer.example", OIDC_AUDIENCE: "audience" })).toThrow("production requires");
  });

  it("accepts explicit postgres persistence with required production dependencies", () => {
    const config = loadConfig({ ...productionEnvironment(), CORS_ALLOWED_ORIGINS: "https://research.example" });
    expect(config.PERSISTENCE_MODE).toBe("postgres");
  });

  it("requires a valid SEC user agent for production filing retrieval", () => {
    expect(() => loadConfig({ ...productionEnvironment(), SEC_USER_AGENT: undefined })).toThrow("production requires");
  });

  it("requires an administrator-approved tool catalog in production", () => {
    expect(() => loadConfig({ ...productionEnvironment(), TOOL_MANIFEST_CATALOG_JSON: undefined })).toThrow("production requires");
  });

  it("requires a Redshift Serverless database secret in production", () => {
    expect(() => loadConfig({ ...productionEnvironment(), REDSHIFT_SECRET_ARN: undefined })).toThrow("production requires");
  });

  it("does not accept direct market-data provider credentials in the runtime configuration", () => {
    const config = loadConfig({ MARKET_DATA_PROVIDER: "intrinio", MARKET_DATA_API_KEY: "not-a-runtime-secret" });
    expect(config).not.toHaveProperty("MARKET_DATA_PROVIDER");
    expect(config).not.toHaveProperty("MARKET_DATA_API_KEY");
  });

  it("rejects wildcard and localhost origins in production", () => {
    const base = productionEnvironment();
    expect(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: "*" })).toThrow("must not contain a wildcard");
    expect(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: "http://localhost:3000" })).toThrow("non-localhost HTTPS origin");
  });

  it("uses a visibility lease longer than the maximum research runtime by default", () => {
    expect(loadConfig({}).SQS_RESEARCH_RUN_VISIBILITY_TIMEOUT_SECONDS).toBe(360);
  });

  it("uses bounded active-run defaults and rejects invalid submission quotas", () => {
    expect(loadConfig({})).toMatchObject({ MAX_ACTIVE_RUNS_PER_USER: 2, MAX_ACTIVE_RUNS_PER_ORGANIZATION: 10, MEMORY_RETENTION_BATCH_SIZE: 100, SEC_MAX_RESPONSE_BYTES: 5 * 1024 * 1024 });
    expect(() => loadConfig({ MAX_ACTIVE_RUNS_PER_USER: "0" })).toThrow();
    expect(() => loadConfig({ MAX_ACTIVE_RUNS_PER_ORGANIZATION: "201" })).toThrow();
    expect(() => loadConfig({ MEMORY_RETENTION_BATCH_SIZE: "1001" })).toThrow();
    expect(() => loadConfig({ SEC_MAX_RESPONSE_BYTES: "1024" })).toThrow();
  });

  it("gives the database migration task a deliberately narrow configuration contract", () => {
    expect(loadMigrationConfig({ NODE_ENV: "production", PERSISTENCE_MODE: "postgres", DATABASE_URL: "postgresql://migration:password@database.internal/research" })).toEqual({
      NODE_ENV: "production",
      PERSISTENCE_MODE: "postgres",
      DATABASE_URL: "postgresql://migration:password@database.internal/research",
    });
    expect(() => loadMigrationConfig({ NODE_ENV: "production", PERSISTENCE_MODE: "memory" })).toThrow("database migrations require");
  });

  it("keeps production profile dependencies scoped to the executable that uses them", () => {
    const base = productionEnvironment();
    const api = loadApiConfig({ ...omit(base, ["BEDROCK_MODEL_ID", "BEDROCK_INPUT_COST_PER_1K_USD", "BEDROCK_OUTPUT_COST_PER_1K_USD", "REDSHIFT_WORKGROUP", "REDSHIFT_DATABASE", "REDSHIFT_SECRET_ARN", "MARKET_DATA_LICENSE", "SEC_USER_AGENT"]), CORS_ALLOWED_ORIGINS: "https://research.example" });
    expect(api.OIDC_ISSUER).toBe(base.OIDC_ISSUER);

    const worker = loadWorkerConfig({
      ...omit(base, ["CORS_ALLOWED_ORIGINS", "OIDC_ISSUER", "OIDC_AUDIENCE"]),
      EVENTBRIDGE_EVENT_BUS_NAME: "research-domain-events",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.example/v1/traces",
    });
    expect(worker.REDSHIFT_SECRET_ARN).toBe(base.REDSHIFT_SECRET_ARN);

    const ingestion = loadSecIngestionConfig({
      NODE_ENV: "production",
      PERSISTENCE_MODE: "postgres",
      DATABASE_URL: base.DATABASE_URL,
      SEC_USER_AGENT: base.SEC_USER_AGENT,
      BEDROCK_EMBEDDING_MODEL_ID: base.BEDROCK_EMBEDDING_MODEL_ID,
      OPENSEARCH_ENDPOINT: base.OPENSEARCH_ENDPOINT,
      OPENSEARCH_INDEX: base.OPENSEARCH_INDEX,
      EVIDENCE_S3_BUCKET: base.EVIDENCE_S3_BUCKET,
      NEO4J_URI: base.NEO4J_URI,
      NEO4J_USERNAME: base.NEO4J_USERNAME,
      NEO4J_PASSWORD: base.NEO4J_PASSWORD,
      SEC_INGEST_TENANT_ID: "11111111-1111-4111-8111-111111111111",
      SEC_INGEST_TICKERS: "NVDA,AMD",
    });
    expect(ingestion.SEC_INGEST_TICKERS).toBe("NVDA,AMD");

    const retention = loadMemoryRetentionConfig(omit(ingestion, ["SEC_USER_AGENT", "SEC_INGEST_TENANT_ID", "SEC_INGEST_TICKERS"]));
    expect(retention.MEMORY_RETENTION_BATCH_SIZE).toBe(100);
  });
});

describe("local environment loading", () => {
  it("loads the nearest development .env without overriding deployment-provided values", () => {
    const root = temporaryDirectory();
    const nested = join(root, "apps", "api");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".env"), "API_PORT=3101\nGREETING='research analyst'\nVALUE=from-file # note\n");
    const environment: NodeJS.ProcessEnv = { API_PORT: "3999" };

    loadLocalEnvironment({ environment, cwd: nested });

    expect(environment).toMatchObject({ API_PORT: "3999", GREETING: "research analyst", VALUE: "from-file" });
  });

  it("does not read a local file when the process is explicitly production", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, ".env"), "API_PORT=3101\n");
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "production" };

    loadLocalEnvironment({ environment, cwd: root });

    expect(environment.API_PORT).toBeUndefined();
  });

  it("keeps dotenv parsing inert and rejects malformed assignments", () => {
    expect([...parseLocalEnvironment("export FLAG=true\nCOMMAND=$(whoami)\n")]).toEqual([["FLAG", "true"], ["COMMAND", "$(whoami)"]]);
    expect(() => parseLocalEnvironment("NOT AN ASSIGNMENT")).toThrow("line 1");
    expect(() => parseLocalEnvironment("KEY='unterminated")).toThrow("unterminated");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "research-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

function productionEnvironment() {
  return {
    NODE_ENV: "production" as const,
    PERSISTENCE_MODE: "postgres" as const,
    DATABASE_URL: "postgres://localhost/db",
    REDIS_URL: "redis://localhost",
    SQS_RESEARCH_RUN_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/queue",
    BEDROCK_MODEL_ID: "model",
    BEDROCK_EMBEDDING_MODEL_ID: "embedding",
    BEDROCK_INPUT_COST_PER_1K_USD: "0.003",
    BEDROCK_OUTPUT_COST_PER_1K_USD: "0.015",
    BEDROCK_EMBEDDING_INPUT_COST_PER_1K_USD: "0.0001",
    OPENSEARCH_ENDPOINT: "https://search.example",
    OPENSEARCH_INDEX: "evidence-v1",
    EVIDENCE_S3_BUCKET: "research-evidence-bucket",
    REDSHIFT_WORKGROUP: "research",
    REDSHIFT_DATABASE: "warehouse",
    REDSHIFT_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:research-redshift",
    MARKET_DATA_LICENSE: "licensed",
    NEO4J_URI: "neo4j+s://graph.example",
    NEO4J_USERNAME: "neo4j",
    NEO4J_PASSWORD: "secret",
    OIDC_ISSUER: "https://issuer.example",
    OIDC_AUDIENCE: "audience",
    SEC_USER_AGENT: "Research Agent test@example.com",
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

function omit(value: object, keys: string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as NodeJS.ProcessEnv;
}
