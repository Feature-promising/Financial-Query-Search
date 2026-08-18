import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import {
  CreateConversationSchema,
  CreateReportSchema,
  CreateTurnSchema,
  ConversationIdParamsSchema,
  ConversationDetailViewSchema,
  ConversationListQuerySchema,
  ConversationListResponseSchema,
  ConversationViewSchema,
  EvidenceIdParamsSchema,
  EvidenceViewSchema,
  MemoryIdParamsSchema,
  ReportIdParamsSchema,
  RunIdParamsSchema,
  SaveConfirmedPreferenceSchema,
  UpdateConversationSchema,
  publicRunFailurePayload,
  RunEventSchema,
  type NewRunEvent,
  ResearchScopeSchema,
  ResearchReportViewSchema,
  ResearchRunViewSchema,
  RunBudgetSchema,
  type ResearchScope,
  type RunEvent,
} from "@research/contracts";
import { InMemoryConversationStore, type ConversationStore } from "@research/conversation";
import { ResearchRuntime, runResearchGraph, type ClaimComposer, type IntentAnalyzer, type Planner, type RunEventSink } from "@research/agent-runtime";
import { InMemoryStore, UserPreferenceMemoryService, type MemoryStore } from "@research/memory";
import { createDefaultToolRegistry, createSubmissionToolRegistry, parseApprovedToolManifestCatalog, type ToolRegistry } from "@research/tools";
import { loadApiConfig, loadLocalEnvironment, parseAllowedOrigins } from "@research/config";
import { BedrockClaimComposer, BedrockIntentAnalyzer, BedrockStructuredModel } from "@research/models";
import { InMemoryRunStore, markRunFailedIfActive, type RunStore } from "@research/runs";
import type { ReportStore } from "@research/reports";
import { AuthenticationError, OidcTokenVerifier } from "@research/auth";
import type { EvidenceStore } from "@research/knowledge";
import { RedisRunEventWakeup, type RunEventWakeup } from "@research/live-events";
import { createStores } from "./composition/stores.js";
import { registerApiErrorHandler, sendApiError } from "./errors.js";
import { registerReadinessRoute, type ReadinessProbe } from "./readiness.js";
import type { PrincipalProvisioner, RunSubmissionStore } from "@research/db";

export interface IdentityProvider { getScope(request: FastifyRequest): Promise<ResearchScope>; }

/** Development identity only. Production must inject a verified OIDC implementation. */
export class HeaderIdentityProvider implements IdentityProvider {
  async getScope(request: FastifyRequest): Promise<ResearchScope> {
    return ResearchScopeSchema.parse({
      organizationId: String(request.headers["x-organization-id"] ?? "local-research"),
      userId: String(request.headers["x-user-id"] ?? "local-analyst"),
      roles: [String(request.headers["x-role"] ?? "researcher") === "admin" ? "admin" : "researcher"],
      entitlements: String(request.headers["x-entitlements"] ?? "").split(",").filter(Boolean),
    });
  }
}

export class RejectingIdentityProvider implements IdentityProvider {
  async getScope(): Promise<ResearchScope> {
    throw new AuthenticationError();
  }
}

export class OidcIdentityProvider implements IdentityProvider {
  constructor(private readonly verifier: OidcTokenVerifier) {}
  async getScope(request: FastifyRequest): Promise<ResearchScope> {
    const authorization = request.headers.authorization;
    return this.verifier.verifyAuthorizationHeader(Array.isArray(authorization) ? authorization[0] : authorization);
  }
}

class SseEventSink implements RunEventSink {
  readonly events: RunEvent[] = [];
  private pending = Promise.resolve();
  constructor(private readonly runId: string, private readonly write: (event: RunEvent) => void, private readonly persist?: (event: RunEvent) => Promise<void>) {}
  async append(event: NewRunEvent): Promise<RunEvent> {
    const operation = this.pending.then(async () => {
      const stored = RunEventSchema.parse({ ...event, id: randomUUID(), sequence: this.events.length + 1 });
      this.events.push(stored);
      await this.persist?.(stored);
      this.write(stored);
      return stored;
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export interface ApiDependencies {
  identity: IdentityProvider;
  conversations: ConversationStore;
  memories: MemoryStore;
  tools: ToolRegistry;
  runs: RunStore;
  reports: ReportStore;
  evidence?: EvidenceStore;
  submissions?: RunSubmissionStore;
  /** Production submission limits; development falls back to safe defaults. */
  maxActiveRunsPerUser?: number;
  maxActiveRunsPerOrganization?: number;
  provisioner?: PrincipalProvisioner;
  liveEvents?: RunEventWakeup;
  readiness?: ReadinessProbe;
  agentOverrides?: { intentAnalyzer?: IntentAnalyzer; planner?: Planner; claimComposer?: ClaimComposer };
}

async function resolveScope(request: FastifyRequest, dependencies: ApiDependencies): Promise<ResearchScope> {
  const scope = await dependencies.identity.getScope(request);
  return dependencies.provisioner ? dependencies.provisioner.resolve(scope) : scope;
}

export function createApi(dependencies: ApiDependencies, allowedOrigins = ["http://localhost:3000"]): FastifyInstance {
  const app = Fastify({ logger: true });
  registerApiErrorHandler(app);
  app.setNotFoundHandler((request, reply) => sendApiError(reply, 404, "NOT_FOUND", "resource not found", request.id));
  app.register(cors, {
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error("origin is not allowed"), false);
    },
    // A turn is streamed, so the client needs this server-assigned identifier
    // as soon as response headers arrive to offer the queued-run control.
    exposedHeaders: ["x-research-run-id"],
  });
  app.get("/health", async () => ({ status: "ok", service: "interactive-research-agent" }));
  registerReadinessRoute(app, dependencies.readiness);

  app.post("/v1/conversations", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const input = CreateConversationSchema.parse(request.body ?? {});
    const conversation = await dependencies.conversations.create(scope, input.title);
    return reply.code(201).send(ConversationViewSchema.parse(conversation));
  });

  app.get("/v1/conversations", async (request) => {
    const scope = await resolveScope(request, dependencies);
    const query = ConversationListQuerySchema.parse(request.query ?? {});
    const page = await dependencies.conversations.listPage(scope, query);
    return ConversationListResponseSchema.parse({ conversations: page.conversations, nextCursor: page.nextCursor ?? null });
  });

  app.get("/v1/conversations/:conversationId", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { conversationId } = ConversationIdParamsSchema.parse(request.params);
    const conversation = await dependencies.conversations.get(scope, conversationId);
    if (!conversation) return sendApiError(reply, 404, "NOT_FOUND", "conversation not found", request.id);
    return ConversationDetailViewSchema.parse({ conversation, messages: await dependencies.conversations.listMessages(scope, conversationId) });
  });

  app.patch("/v1/conversations/:conversationId", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { conversationId } = ConversationIdParamsSchema.parse(request.params);
    const input = UpdateConversationSchema.parse(request.body);
    const conversation = await dependencies.conversations.rename(scope, conversationId, input.title);
    if (!conversation) return sendApiError(reply, 404, "NOT_FOUND", "conversation not found", request.id);
    return ConversationViewSchema.parse(conversation);
  });

  app.post("/v1/conversations/:conversationId/archive", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { conversationId } = ConversationIdParamsSchema.parse(request.params);
    const conversation = await dependencies.conversations.setArchived(scope, conversationId, true);
    if (!conversation) return sendApiError(reply, 404, "NOT_FOUND", "conversation not found", request.id);
    return ConversationViewSchema.parse(conversation);
  });

  app.post("/v1/conversations/:conversationId/unarchive", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { conversationId } = ConversationIdParamsSchema.parse(request.params);
    const conversation = await dependencies.conversations.setArchived(scope, conversationId, false);
    if (!conversation) return sendApiError(reply, 404, "NOT_FOUND", "conversation not found", request.id);
    return ConversationViewSchema.parse(conversation);
  });

  app.delete("/v1/conversations/:conversationId", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { conversationId } = ConversationIdParamsSchema.parse(request.params);
    if (!await dependencies.conversations.delete(scope, conversationId)) {
      return sendApiError(reply, 404, "NOT_FOUND", "conversation not found", request.id);
    }
    return reply.code(204).send();
  });

  app.post("/v1/conversations/:conversationId/turns", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { conversationId } = ConversationIdParamsSchema.parse(request.params);
    const conversation = await dependencies.conversations.get(scope, conversationId);
    if (!conversation) return sendApiError(reply, 404, "NOT_FOUND", "conversation not found", request.id);
    if (conversation.archivedAt) return sendApiError(reply, 409, "CONVERSATION_ARCHIVED", "restore the archived conversation before starting new research", request.id);
    const input = CreateTurnSchema.parse(request.body);
    const runId = randomUUID();
    const budget = RunBudgetSchema.parse({});
    const history = await dependencies.conversations.listMessages(scope, conversationId);
    // Capture the exact authorized tool configuration before handing work to
    // SQS. A Worker will reject tools absent from, or changed since, this
    // snapshot; it never re-discovers capabilities from an LLM request.
    const toolManifestSnapshot = dependencies.tools.discover(scope);
    const command = { version: "v2" as const, runId, conversationId, scope, question: input.question, toolManifestSnapshot, requestedAt: new Date().toISOString() };
    // This immutable ID belongs to the submitted run, not to a client-created
    // draft. It enables reconnect and the narrowly safe queued pause action
    // before the first SSE body chunk reaches the browser.
    reply.header("x-research-run-id", runId);
    if (dependencies.submissions) {
      const submitted = await dependencies.submissions.submit({
        runId, organizationId: scope.organizationId, actorUserId: scope.userId, isOrganizationAdmin: scope.roles.includes("admin"), conversationId, question: input.question, budget, command,
        maxActiveRunsPerUser: dependencies.maxActiveRunsPerUser ?? 2,
        maxActiveRunsPerOrganization: dependencies.maxActiveRunsPerOrganization ?? 10,
      });
      if (submitted === "not_found") return sendApiError(reply, 404, "NOT_FOUND", "conversation not found", request.id);
      if (submitted === "conversation_archived") return sendApiError(reply, 409, "CONVERSATION_ARCHIVED", "restore the archived conversation before starting new research", request.id);
      if (submitted === "active_run_limit_exceeded") return sendApiError(reply, 429, "RUN_LIMIT_EXCEEDED", "too many active research runs; wait for an existing run to finish", request.id);
      openPersistedEventStream(reply, dependencies.runs, scope, runId, 0, dependencies.liveEvents, sseResponseHeaders(request, allowedOrigins, { "x-research-run-id": runId }));
      return;
    }
    await dependencies.runs.create({ id: runId, organizationId: scope.organizationId, conversationId, createdBy: conversation.createdBy, question: input.question, budget });
    await dependencies.conversations.appendMessage(scope, { conversationId, role: "user", content: input.question, runId });
    if (!await dependencies.runs.claim(scope, runId)) return sendApiError(reply, 409, "RUN_NOT_QUEUED", "unable to claim the newly created run", request.id);

    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no", ...sseResponseHeaders(request, allowedOrigins, { "x-research-run-id": runId }) });
    const sink = new SseEventSink(runId, (event) => reply.raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`), (event) => dependencies.runs.appendEvent(scope, event));
    try {
      const runtime = new ResearchRuntime({ tools: dependencies.tools, memories: dependencies.memories, events: sink, ...dependencies.agentOverrides });
      const result = await runResearchGraph(runtime, {
        runId,
        conversationId,
        question: input.question,
        scope,
        budget,
        toolManifestSnapshot,
        recentMessages: history.map((message) => ({ role: message.role, content: message.content })),
      });
      // Keep the in-process development/recovery path observably equivalent
      // to DurableResearchRunHandler: citations must resolve to durable,
      // tenant-scoped evidence before a completed report can be delivered.
      if (result.state.evidence.length) {
        if (!dependencies.evidence) throw new Error("evidence store is required to publish cited research");
        await dependencies.evidence.save(scope, runId, result.state.evidence);
      }
      await dependencies.conversations.appendPublishedAssistantMessage(scope, { conversationId, content: result.answer, runId });
      if (result.status === "completed") {
        if (!result.report) throw new Error("completed research run has no controlled report");
        await dependencies.reports.create(scope, {
          runId,
          organizationId: scope.organizationId,
          ownerUserId: conversation.createdBy,
          markdown: result.report.markdown,
          citations: result.report.citations,
        });
      }
      // A report is deliberately written before the terminal status. The API
      // gates report reads on this status, so an interrupted finalization can
      // never expose a conclusion that lacks a completed, auditable run.
      await dependencies.runs.finish(scope, runId, result.status, result.answer);
      // Development has no cross-store publication transaction. Persist the
      // research asset only after its report, assistant message, and terminal
      // status are durable; production uses the Worker finalizer transaction.
      if (result.status === "completed" && result.researchMemory) {
        await dependencies.memories.save(result.researchMemory).catch(() => undefined);
      }
    } catch (error) {
      // Event persistence and transport are diagnostic paths; neither may
      // leave an active run stranded if they are impaired.
      try {
        await sink.append({ runId, type: "failed", at: new Date().toISOString(), payload: publicRunFailurePayload() });
      } catch {
        // The terminal transition below remains the authoritative fallback.
      }
      await markRunFailedIfActive(dependencies.runs, scope, runId).catch(() => undefined);
    } finally { reply.raw.end(); }
  });

  app.get("/v1/runs/:runId", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { runId } = RunIdParamsSchema.parse(request.params);
    const run = await dependencies.runs.get(scope, runId);
    if (!run) return sendApiError(reply, 404, "NOT_FOUND", "run not found", request.id);
    return ResearchRunViewSchema.parse(run);
  });

  app.post("/v1/runs/:runId/pause", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { runId } = RunIdParamsSchema.parse(request.params);
    const run = await dependencies.runs.get(scope, runId);
    if (!run) return sendApiError(reply, 404, "NOT_FOUND", "run not found", request.id);
    const outcome = await dependencies.runs.pause(scope, runId, {
      id: randomUUID(), runId, sequence: run.events.length + 1, type: "run_paused", at: new Date().toISOString(),
      payload: { reason: "user_requested", safeBoundary: "queued" },
    });
    if (outcome === "not_found") return sendApiError(reply, 404, "NOT_FOUND", "run not found", request.id);
    if (outcome !== "paused") return sendApiError(reply, 409, "RUN_PAUSE_UNAVAILABLE", "a run can be paused only before a worker starts research execution", request.id);
    const paused = await dependencies.runs.get(scope, runId);
    if (!paused) return sendApiError(reply, 404, "NOT_FOUND", "run not found", request.id);
    return ResearchRunViewSchema.parse(paused);
  });

  app.post("/v1/runs/:runId/resume", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { runId } = RunIdParamsSchema.parse(request.params);
    const run = await dependencies.runs.get(scope, runId);
    if (!run) return sendApiError(reply, 404, "NOT_FOUND", "run not found", request.id);
    const outcome = await dependencies.runs.resume(scope, runId, {
      id: randomUUID(), runId, sequence: run.events.length + 1, type: "run_resumed", at: new Date().toISOString(),
      payload: { reason: "user_requested", safeBoundary: "queued" },
    });
    if (outcome === "not_found") return sendApiError(reply, 404, "NOT_FOUND", "run not found", request.id);
    if (outcome === "command_missing") return sendApiError(reply, 409, "RUN_RESUME_UNAVAILABLE", "the immutable research command is unavailable and cannot be safely resumed", request.id);
    if (outcome !== "resumed") return sendApiError(reply, 409, "RUN_RESUME_UNAVAILABLE", "only a paused queued run can be resumed", request.id);
    const resumed = await dependencies.runs.get(scope, runId);
    if (!resumed) return sendApiError(reply, 404, "NOT_FOUND", "run not found", request.id);
    return ResearchRunViewSchema.parse(resumed);
  });

  app.get("/v1/runs/:runId/events", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { runId } = RunIdParamsSchema.parse(request.params);
    const run = await dependencies.runs.get(scope, runId);
    if (!run) return sendApiError(reply, 404, "NOT_FOUND", "run not found", request.id);
    const accept = Array.isArray(request.headers.accept) ? request.headers.accept[0] : request.headers.accept;
    if (accept?.includes("text/event-stream")) {
      openPersistedEventStream(reply, dependencies.runs, scope, run.id, parseEventCursor(request), dependencies.liveEvents, sseResponseHeaders(request, allowedOrigins));
      return;
    }
    return { events: run.events };
  });

  app.get("/v1/evidence/:evidenceId", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { evidenceId } = EvidenceIdParamsSchema.parse(request.params);
    const evidence = await dependencies.evidence?.get(scope, evidenceId);
    if (!evidence) return sendApiError(reply, 404, "NOT_FOUND", "evidence not found", request.id);
    return EvidenceViewSchema.parse(evidence);
  });

  app.get("/v1/memory/preferences", async (request) => {
    const scope = await resolveScope(request, dependencies);
    return { preferences: await new UserPreferenceMemoryService(dependencies.memories).list({ tenantId: scope.organizationId, userId: scope.userId }) };
  });

  app.put("/v1/memory/preferences", async (request) => {
    const scope = await resolveScope(request, dependencies);
    const input = SaveConfirmedPreferenceSchema.parse(request.body);
    const preference = await new UserPreferenceMemoryService(dependencies.memories).save(
      { tenantId: scope.organizationId, userId: scope.userId },
      input.preference,
    );
    return { preference };
  });

  app.delete("/v1/memory/:memoryId", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { memoryId } = MemoryIdParamsSchema.parse(request.params);
    const record = await dependencies.memories.get(memoryId, scope.organizationId);
    if (!record) return sendApiError(reply, 404, "NOT_FOUND", "memory record not found", request.id);
    // A legal hold is an organization retention control, not a user/admin
    // preference. Its release belongs to a separately authorized compliance
    // workflow and must never be reachable through the user deletion API.
    if (record.retentionPolicy === "legal_hold") {
      return sendApiError(reply, 409, "MEMORY_RETENTION_LOCKED", "memory record is subject to a retention hold", request.id);
    }
    const canDelete = record.userId === scope.userId || scope.roles.includes("admin");
    if (!canDelete) return sendApiError(reply, 403, "FORBIDDEN", "memory record is not deletable by this user", request.id);
    await dependencies.memories.delete(memoryId, scope.organizationId, scope.userId);
    return reply.code(204).send();
  });

  app.post("/v1/reports", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const input = CreateReportSchema.parse(request.body);
    const run = await dependencies.runs.get(scope, input.runId);
    if (!run) return sendApiError(reply, 404, "NOT_FOUND", "run not found", request.id);
    if (run.status !== "completed") return sendApiError(reply, 409, "REPORT_NOT_READY", "a complete, cited run is required before report delivery", request.id);
    const report = await dependencies.reports.getByRun(scope, input.runId);
    if (!report) return sendApiError(reply, 404, "NOT_FOUND", "report has not been persisted by the worker", request.id);
    return reply.code(202).send(ResearchReportViewSchema.parse(report));
  });

  app.get("/v1/reports/:reportId", async (request, reply) => {
    const scope = await resolveScope(request, dependencies);
    const { reportId } = ReportIdParamsSchema.parse(request.params);
    const report = await dependencies.reports.get(scope, reportId);
    if (!report) return sendApiError(reply, 404, "NOT_FOUND", "report not found", request.id);
    const run = await dependencies.runs.get(scope, report.runId);
    if (!run || run.status !== "completed") return sendApiError(reply, 404, "NOT_FOUND", "report not found", request.id);
    return ResearchReportViewSchema.parse(report);
  });

  return app;
}

function openPersistedEventStream(reply: FastifyReply, runs: RunStore, scope: ResearchScope, runId: string, initialSequence: number, liveEvents?: RunEventWakeup, responseHeaders: Record<string, string> = {}): void {
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no", ...responseHeaders });
  let sequence = initialSequence;
  let closed = false;
  reply.raw.once("close", () => { closed = true; });
  const pump = async (): Promise<void> => {
    if (closed) return;
    try {
      const run = await runs.get(scope, runId);
      if (!run) { reply.raw.end(); return; }
      for (const event of run.events.filter((candidate) => candidate.sequence > sequence)) {
        sequence = event.sequence;
        reply.raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      // A paused run has no producer until an explicit resume enqueues its
      // immutable command again. Close this stream so clients can render the
      // durable paused state instead of waiting indefinitely.
      if (["paused", "completed", "abstained", "failed"].includes(run.status)) { reply.raw.end(); return; }
      try {
        // A bounded wait keeps PostgreSQL replay responsive during a Redis
        // outage while avoiding the previous fixed 250 ms polling in normal use.
        if (liveEvents) await liveEvents.waitFor(runId, 1_000);
        else await wait(250);
      }
      catch { await wait(250); }
      if (!closed) void pump();
    } catch {
      reply.raw.end();
    }
  };
  void pump();
}

function parseEventCursor(request: FastifyRequest): number {
  const header = request.headers["last-event-id"];
  const value = Array.isArray(header) ? header[0] : header;
  const cursor = Number(value ?? (request.query as { after?: string }).after ?? 0);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

/**
 * SSE is sent through Node's raw response after `reply.hijack()`, which skips
 * Fastify's normal response-header hooks. Reapply the same explicit origin
 * allowlist here so initial streams and reconnects remain browser-readable
 * without weakening CORS for unapproved origins.
 */
function sseResponseHeaders(request: FastifyRequest, allowedOrigins: string[], headers: Record<string, string> = {}): Record<string, string> {
  const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) return headers;
  return {
    ...headers,
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "x-research-run-id",
    vary: "Origin",
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

loadLocalEnvironment();
const config = loadApiConfig();
// Validate the deployment-owned tool approval before opening database or Redis
// connections. This keeps malformed catalog failures deterministic and free of
// partially initialized request-path resources.
const approvedToolManifests = config.NODE_ENV === "production"
  ? parseApprovedToolManifestCatalog(config.TOOL_MANIFEST_CATALOG_JSON!)
  : undefined;
const allowedOrigins = parseAllowedOrigins(config.CORS_ALLOWED_ORIGINS);
const identity = config.NODE_ENV === "production"
  ? new OidcIdentityProvider(new OidcTokenVerifier({ issuer: config.OIDC_ISSUER!, audience: config.OIDC_AUDIENCE!, organizationClaim: config.OIDC_ORGANIZATION_CLAIM, rolesClaim: config.OIDC_ROLES_CLAIM, entitlementsClaim: config.OIDC_ENTITLEMENTS_CLAIM, emailClaim: config.OIDC_EMAIL_CLAIM }))
  : new HeaderIdentityProvider();
const model = config.BEDROCK_MODEL_ID ? new BedrockStructuredModel({ region: config.AWS_REGION, modelId: config.BEDROCK_MODEL_ID }) : undefined;
const agentOverrides: ApiDependencies["agentOverrides"] = model ? {
  intentAnalyzer: new BedrockIntentAnalyzer(model),
  claimComposer: { compose: async (evidence, state, signal) => new BedrockClaimComposer(model).compose(state.run.question, evidence, signal) },
} : undefined;
const stores = createStores(config);
const liveEvents = config.NODE_ENV === "production" && config.REDIS_URL ? new RedisRunEventWakeup({ url: config.REDIS_URL, streamKey: config.REDIS_RUN_EVENT_STREAM_KEY }) : undefined;
await liveEvents?.start();
const submissionTools = config.NODE_ENV === "production"
  ? createSubmissionToolRegistry(approvedToolManifests!)
  : createDefaultToolRegistry({ secUserAgent: config.SEC_USER_AGENT, secMaxResponseBytes: config.SEC_MAX_RESPONSE_BYTES });
const app = createApi({ identity, ...stores, tools: submissionTools, agentOverrides, liveEvents, maxActiveRunsPerUser: config.MAX_ACTIVE_RUNS_PER_USER, maxActiveRunsPerOrganization: config.MAX_ACTIVE_RUNS_PER_ORGANIZATION }, allowedOrigins);
app.addHook("onClose", async () => { await liveEvents?.close(); await stores.close(); });
if (import.meta.url === `file://${process.argv[1]}`) {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}
