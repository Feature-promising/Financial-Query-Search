import { z } from "zod";

export const ResearchScopeSchema = z.object({
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  email: z.string().email().optional(),
  roles: z.array(z.enum(["researcher", "admin"])).min(1),
  entitlements: z.array(z.string()).default([]),
});
export type ResearchScope = z.infer<typeof ResearchScopeSchema>;

/**
 * Private conversation-derived resources are visible only to their creator.
 * Organization administrators retain the explicitly granted audit/support
 * exception. Keep this rule shared so in-memory and database adapters cannot
 * silently drift into different authorization semantics.
 */
export function canAccessOwnedResource(scope: ResearchScope, organizationId: string, ownerUserId: string): boolean {
  return scope.organizationId === organizationId && (scope.userId === ownerUserId || scope.roles.includes("admin"));
}

export const RunBudgetSchema = z.object({
  maxTasks: z.number().int().positive().max(12).default(12),
  maxToolCalls: z.number().int().positive().max(30).default(24),
  maxToolDurationMs: z.number().int().positive().max(20_000).default(20_000),
  maxRunDurationMs: z.number().int().positive().max(300_000).default(300_000),
  maxCriticRepairs: z.number().int().min(0).max(1).default(1),
  maxEstimatedCostUsd: z.number().positive().max(50).default(5),
});
export type RunBudget = z.infer<typeof RunBudgetSchema>;

export const ResearchRunStatusSchema = z.enum(["queued", "running", "paused", "completed", "abstained", "failed"]);
export type ResearchRunStatus = z.infer<typeof ResearchRunStatusSchema>;

export class RunCostBudgetExceeded extends Error {
  constructor() { super("research run cost budget exhausted"); }
}

/**
 * Process-local accounting for one run. Callers reserve known maximum costs
 * before billable work, then settle with the provider's actual usage.
 */
export class RunCostLedger {
  private spentUsd = 0;
  private reservedUsd = 0;

  constructor(readonly limitUsd: number) {}

  get spent(): number { return this.spentUsd; }
  get reserved(): number { return this.reservedUsd; }
  get available(): number { return Math.max(0, this.limitUsd - this.spentUsd - this.reservedUsd); }
  get exhausted(): boolean { return this.available <= 0; }

  reserve(maximumCostUsd: number): number | undefined {
    if (!Number.isFinite(maximumCostUsd) || maximumCostUsd < 0 || maximumCostUsd > this.available) return undefined;
    this.reservedUsd += maximumCostUsd;
    return maximumCostUsd;
  }

  settle(reservationUsd: number, actualCostUsd: number): boolean {
    this.reservedUsd = Math.max(0, this.reservedUsd - reservationUsd);
    this.spentUsd += Math.max(0, actualCostUsd);
    return this.spentUsd + this.reservedUsd <= this.limitUsd;
  }

  spend(actualCostUsd: number): boolean {
    this.spentUsd += Math.max(0, actualCostUsd);
    return this.spentUsd + this.reservedUsd <= this.limitUsd;
  }
}

export const IntentSchema = z.object({
  category: z.enum(["company_analysis", "comparison", "earnings", "industry", "valuation", "report", "other"]),
  entities: z.array(z.string()).max(10),
  tickers: z.array(z.string().regex(/^[A-Z.]{1,10}$/)).max(10),
  period: z.string().nullable(),
  complexity: z.enum(["simple", "research", "deep_research"]),
  riskLevel: z.enum(["low", "medium", "high"]),
  requiredCapabilities: z.array(z.string()),
});
export type Intent = z.infer<typeof IntentSchema>;

export const TaskStatusSchema = z.enum(["pending", "running", "completed", "failed", "skipped"]);
export const ResearchTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  dependsOn: z.array(z.string()),
  // A task is an atomic, replayable tool invocation. Multi-step research is
  // represented by explicit DAG tasks rather than silently choosing one tool.
  allowedTools: z.array(z.string()).min(1).max(1),
  acceptanceCriteria: z.array(z.string()).min(1),
  status: TaskStatusSchema.default("pending"),
});
export type ResearchTask = z.infer<typeof ResearchTaskSchema>;

/** A source-bound graph fact supplied by a trusted ingestion adapter. */
export const EvidenceGraphRelationSchema = z.object({
  subject: z.string().trim().min(1).max(256),
  predicate: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  object: z.string().trim().min(1).max(256),
}).superRefine((relation, context) => {
  if (relation.subject.localeCompare(relation.object, undefined, { sensitivity: "accent" }) === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["object"], message: "graph relation cannot target itself" });
  }
});
export type EvidenceGraphRelation = z.infer<typeof EvidenceGraphRelationSchema>;

/** Evidence links are opened in the browser, so non-web URL schemes are never valid sources. */
export function isHttpSourceUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch { return false; }
}

export const HttpSourceUrlSchema = z.string().url().refine(isHttpSourceUrl, "source URL must use http or https");

export const EvidenceItemSchema = z.object({
  id: z.string().uuid(),
  sourceType: z.enum(["sec_filing", "company_ir", "market_data", "news", "research_memory", "graph"]),
  authority: z.enum(["primary", "licensed", "secondary"]),
  title: z.string().min(1),
  content: z.string().min(1),
  sourceUrl: HttpSourceUrlSchema.nullable(),
  locator: z.string().min(1),
  entity: z.string().nullable(),
  publishedAt: z.string().datetime().nullable(),
  asOfDate: z.string().date().nullable(),
  retrievedAt: z.string().datetime(),
  contentHash: z.string().min(16),
  license: z.string().min(1),
  tenantId: z.string().min(1),
  /** Data-license grants required before this evidence can be retrieved or delivered. */
  requiredEntitlements: z.array(z.string().min(1).max(100)).max(20).optional(),
  /**
   * Trusted ingestion adapters may emit source-bound graph facts. The graph
   * writer appends this evidence item's ID to every stored relationship.
   */
  graphRelations: z.array(EvidenceGraphRelationSchema).max(100).optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/** Returns only the access requirements explicitly stored on an evidence record. */
export function requiredEvidenceEntitlements(item: Pick<EvidenceItem, "requiredEntitlements">): string[] {
  return item.requiredEntitlements ?? [];
}

/**
 * Safe compatibility rule for records created before per-evidence licensing.
 * Only primary evidence can be tenant-public without an explicit declaration;
 * licensed and secondary content fail closed until it is re-ingested.
 */
export function effectiveEvidenceEntitlements(item: EvidenceItem): string[] {
  if (item.requiredEntitlements) return item.requiredEntitlements;
  if (item.authority === "licensed") return ["licensed-data"];
  if (item.authority === "secondary") return ["secondary-research"];
  return [];
}

/** Shared authorization rule for retrieval, citation verification, and evidence delivery. */
export function isEvidenceAuthorized(scope: ResearchScope, item: EvidenceItem): boolean {
  return item.tenantId === scope.organizationId
    && effectiveEvidenceEntitlements(item).every((entitlement) => scope.entitlements.includes(entitlement));
}

/**
 * Research memory and graph relations can guide a new search, but neither is
 * an independently source-bound document. They must never support a claim.
 */
export function isClaimEvidenceEligible(item: Pick<EvidenceItem, "sourceType">): boolean {
  return item.sourceType !== "research_memory" && item.sourceType !== "graph";
}

export const ClaimSchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1),
  evidenceIds: z.array(z.string().uuid()).min(1),
  confidence: z.number().min(0).max(1),
  qualification: z.string().nullable(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ResearchPlanSchema = z.object({
  summary: z.string().min(1),
  tasks: z.array(ResearchTaskSchema).min(1).max(12),
}).superRefine((plan, context) => {
  const seen = new Set<string>();
  plan.tasks.forEach((task, index) => {
    if (seen.has(task.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "id"], message: "research task IDs must be unique within a plan" });
    }
    seen.add(task.id);
  });
});
export type ResearchPlan = z.infer<typeof ResearchPlanSchema>;

export const ResearchRunSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  scope: ResearchScopeSchema,
  question: z.string().min(1).max(12_000),
  status: ResearchRunStatusSchema,
  budget: RunBudgetSchema,
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});
export type ResearchRun = z.infer<typeof ResearchRunSchema>;

export const RunEventTypeSchema = z.enum(["run_started", "run_recovered", "run_paused", "run_resumed", "intent_ready", "plan_ready", "task_started", "tool_completed", "evidence_ready", "claim_delta", "critic_result", "completed", "abstained", "failed"]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

/** A durable audit marker emitted only after a failed run was safely reclaimed. */
export const RunRecoveredPayloadSchema = z.object({
  checkpointPhase: z.enum(["context_loaded", "intent_analyzed", "planned"]),
  reason: z.string().min(1),
});
export type RunRecoveredPayload = z.infer<typeof RunRecoveredPayloadSchema>;

/** A queued command was held before any Worker could start billable work. */
export const RunPausedPayloadSchema = z.object({
  reason: z.literal("user_requested"),
  safeBoundary: z.literal("queued"),
});
export type RunPausedPayload = z.infer<typeof RunPausedPayloadSchema>;

/** The original immutable command was returned to the transactional outbox. */
export const RunResumedPayloadSchema = z.object({
  reason: z.literal("user_requested"),
  safeBoundary: z.literal("queued"),
});
export type RunResumedPayload = z.infer<typeof RunResumedPayloadSchema>;

/**
 * Metadata-only lifecycle notification for cross-service consumers. Run event
 * payloads can contain a user question or evidence-derived text and therefore
 * remain in PostgreSQL behind the normal authorization boundary.
 */
export const ResearchRunLifecycleEventSchema = z.object({
  id: z.string().uuid(),
  type: z.literal("research.run.lifecycle"),
  tenantId: z.string().min(1),
  aggregateId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  data: z.object({
    runId: z.string().uuid(),
    sequence: z.number().int().positive(),
    eventType: RunEventTypeSchema,
  }),
});
export type ResearchRunLifecycleEvent = z.infer<typeof ResearchRunLifecycleEventSchema>;

/** Metadata-only notification that a scheduled SEC ingestion batch completed. */
export const SecIngestionCompletedEventSchema = z.object({
  id: z.string().uuid(),
  type: z.literal("knowledge.sec_ingestion.completed"),
  tenantId: z.string().min(1),
  aggregateId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  data: z.object({
    requestedTickerCount: z.number().int().nonnegative().max(100),
    ingestedEvidenceCount: z.number().int().nonnegative().max(100),
    failedTickerCount: z.number().int().nonnegative().max(100),
  }),
});
export type SecIngestionCompletedEvent = z.infer<typeof SecIngestionCompletedEventSchema>;

/** Content-free audit notification for a single tool invocation. */
export const ToolAuditRecordedEventSchema = z.object({
  id: z.string().uuid(),
  type: z.literal("audit.tool_invocation.recorded"),
  tenantId: z.string().min(1),
  aggregateId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  data: z.object({
    runId: z.string().uuid(), toolId: z.string().min(1).max(120), idempotencyKey: z.string().min(1).max(200),
    ok: z.boolean(), failureCode: z.string().max(40).nullable(), estimatedCostUsd: z.number().nonnegative(), durationMs: z.number().int().nonnegative(),
  }),
});
export type ToolAuditRecordedEvent = z.infer<typeof ToolAuditRecordedEventSchema>;

/** Content-free accounting notification for a Bedrock model invocation. */
export const ModelAuditRecordedEventSchema = z.object({
  id: z.string().uuid(),
  type: z.literal("audit.model_invocation.recorded"),
  tenantId: z.string().min(1),
  aggregateId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  data: z.object({
    runId: z.string().uuid(), modelId: z.string().min(1).max(255), operation: z.string().min(1).max(80),
    inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative(), estimatedCostUsd: z.number().nonnegative().nullable(),
  }),
});
export type ModelAuditRecordedEvent = z.infer<typeof ModelAuditRecordedEventSchema>;

/** Versioned allowlist for EventBridge; unknown event types cannot be emitted. */
export const DomainEventSchema = z.discriminatedUnion("type", [ResearchRunLifecycleEventSchema, SecIngestionCompletedEventSchema, ToolAuditRecordedEventSchema, ModelAuditRecordedEventSchema]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;

export const ToolManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
  version: z.string().min(1),
  capability: z.string().min(1),
  requiredEntitlements: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(20_000),
  /** Maximum billable cost for one provider attempt; absent means a free tool. */
  maxEstimatedCostUsd: z.number().finite().nonnegative().max(50).optional(),
  enabled: z.boolean(),
  /** Internal tools are callable only by trusted runtime code, never planned by an LLM. */
  visibility: z.enum(["agent", "internal"]).optional(),
});
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

/** Only submission-time, agent-visible tools may enter a v2 run command. */
export const AgentToolManifestSnapshotSchema = z.array(ToolManifestSchema).min(1).max(100).superRefine((manifests, context) => {
  const ids = new Set<string>();
  for (const [index, manifest] of manifests.entries()) {
    if (ids.has(manifest.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "id"], message: "tool snapshot contains duplicate tool ID" });
    ids.add(manifest.id);
    if (!manifest.enabled) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "enabled"], message: "tool snapshot may not include disabled tools" });
    if (manifest.visibility === "internal") context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "visibility"], message: "tool snapshot may not include internal tools" });
  }
});
export type AgentToolManifestSnapshot = z.infer<typeof AgentToolManifestSnapshotSchema>;

export const ToolFailureSchema = z.object({
  code: z.enum(["UNAUTHORIZED", "DISABLED", "TIMEOUT", "INVALID_INPUT", "UNAVAILABLE", "BUDGET_EXCEEDED", "INTERNAL"]),
  message: z.string(),
  retryable: z.boolean(),
});
export type ToolFailure = z.infer<typeof ToolFailureSchema>;

/** Public-safe terminal failure payload for an authorized run event stream. */
export const PublicRunFailurePayloadSchema = z.object({
  code: z.literal("RUN_FAILED"),
  message: z.literal("Research execution failed before publication. Review the run trace with support if the problem persists."),
});
export type PublicRunFailurePayload = z.infer<typeof PublicRunFailurePayloadSchema>;

/** Never put provider, database, or tool exception text in a user-visible event. */
export function publicRunFailurePayload(): PublicRunFailurePayload {
  return PublicRunFailurePayloadSchema.parse({
    code: "RUN_FAILED",
    message: "Research execution failed before publication. Review the run trace with support if the problem persists.",
  });
}

const publicToolFailureMessages: Record<ToolFailure["code"], string> = {
  UNAUTHORIZED: "The requested capability is not authorized for this research run.",
  DISABLED: "The requested capability is currently disabled.",
  TIMEOUT: "The requested capability did not complete within the allowed time.",
  INVALID_INPUT: "The task has no validated input for the requested capability.",
  UNAVAILABLE: "The requested capability is temporarily unavailable.",
  BUDGET_EXCEEDED: "The research-run resource budget does not allow this capability call.",
  INTERNAL: "The requested capability failed safely before returning evidence.",
};

/** Retains a failure code/retryability while removing untrusted upstream text. */
export function publicToolFailure(failure: ToolFailure): ToolFailure {
  return ToolFailureSchema.parse({
    code: failure.code,
    message: publicToolFailureMessages[failure.code],
    retryable: failure.retryable,
  });
}

/** Stable, content-free failure emitted when a claimed worker lease expires. */
export const RunLeaseExpiredPayloadSchema = z.object({
  code: z.literal("RUN_LEASE_EXPIRED"),
  message: z.literal("Research execution lease expired; automatic replay is permitted only before tool execution."),
});
export type RunLeaseExpiredPayload = z.infer<typeof RunLeaseExpiredPayloadSchema>;

export function runLeaseExpiredPayload(): RunLeaseExpiredPayload {
  return RunLeaseExpiredPayloadSchema.parse({
    code: "RUN_LEASE_EXPIRED",
    message: "Research execution lease expired; automatic replay is permitted only before tool execution.",
  });
}

const RunEventBaseSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  sequence: z.number().int().positive(),
  at: z.string().datetime(),
});

const ToolCompletedPayloadSchema = z.object({
  taskId: z.string().min(1).max(120),
  toolId: z.string().min(1).max(120),
  ok: z.boolean(),
  failure: ToolFailureSchema.optional(),
  estimatedCostUsd: z.number().nonnegative(),
}).superRefine((payload, context) => {
  if (!payload.ok && !payload.failure) context.addIssue({ code: z.ZodIssueCode.custom, path: ["failure"], message: "failed tool event requires a failure" });
  if (payload.ok && payload.failure) context.addIssue({ code: z.ZodIssueCode.custom, path: ["failure"], message: "successful tool event cannot carry a failure" });
});

const CriticResultPayloadSchema = z.object({
  publishable: z.boolean(),
  reason: z.string().min(1).max(8_000),
  rejectedClaimIds: z.array(z.string().uuid()).max(1_000),
  phase: z.enum(["initial", "after_repair", "cost_budget_exhausted", "run_deadline_exceeded", "worker_shutdown", "report_rendering"]),
  repairScheduled: z.boolean().optional(),
  repairReason: z.string().min(1).max(1_000).optional(),
  repairAttempt: z.number().int().min(1).max(1).optional(),
});

/**
 * Wire contract for persisted and streamed research events. Payloads are a
 * finite union rather than arbitrary JSON, so Redis, SSE, and SQL boundaries
 * reject malformed or newly invented event shapes.
 */
export const RunEventSchema = z.discriminatedUnion("type", [
  RunEventBaseSchema.extend({ type: z.literal("run_started"), payload: z.object({ question: z.string().min(1).max(12_000) }) }),
  RunEventBaseSchema.extend({ type: z.literal("run_recovered"), payload: RunRecoveredPayloadSchema }),
  RunEventBaseSchema.extend({ type: z.literal("run_paused"), payload: RunPausedPayloadSchema }),
  RunEventBaseSchema.extend({ type: z.literal("run_resumed"), payload: RunResumedPayloadSchema }),
  RunEventBaseSchema.extend({ type: z.literal("intent_ready"), payload: IntentSchema }),
  RunEventBaseSchema.extend({ type: z.literal("plan_ready"), payload: z.object({ summary: z.string().min(1).max(4_000), tasks: z.array(ResearchTaskSchema).min(1).max(12) }) }),
  RunEventBaseSchema.extend({ type: z.literal("task_started"), payload: z.object({ taskId: z.string().min(1).max(120), title: z.string().min(1).max(1_000) }) }),
  RunEventBaseSchema.extend({ type: z.literal("tool_completed"), payload: ToolCompletedPayloadSchema }),
  RunEventBaseSchema.extend({ type: z.literal("evidence_ready"), payload: z.object({ count: z.number().int().nonnegative().max(10_000) }) }),
  RunEventBaseSchema.extend({ type: z.literal("claim_delta"), payload: ClaimSchema }),
  RunEventBaseSchema.extend({ type: z.literal("critic_result"), payload: CriticResultPayloadSchema }),
  RunEventBaseSchema.extend({ type: z.literal("completed"), payload: z.object({ answer: z.string().min(1).max(200_000), evidenceCount: z.number().int().nonnegative().max(10_000) }) }),
  RunEventBaseSchema.extend({ type: z.literal("abstained"), payload: z.object({ answer: z.string().min(1).max(20_000), evidenceCount: z.number().int().nonnegative().max(10_000) }) }),
  RunEventBaseSchema.extend({ type: z.literal("failed"), payload: z.union([PublicRunFailurePayloadSchema, RunLeaseExpiredPayloadSchema]) }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
type WithoutRunEventIdentifiers<Event extends RunEvent> = Event extends unknown ? Omit<Event, "id" | "sequence"> : never;
export type NewRunEvent = WithoutRunEventIdentifiers<RunEvent>;
export type RunEventPayload<T extends RunEventType> = Extract<RunEvent, { type: T }>["payload"];

/** Validated persisted view used by API replay, recovery, and queue consumers. */
export const StoredRunSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().min(1),
  conversationId: z.string().uuid(),
  createdBy: z.string().min(1),
  question: z.string().min(1).max(12_000),
  budget: RunBudgetSchema,
  status: ResearchRunStatusSchema,
  answer: z.string().optional(),
  events: z.array(RunEventSchema),
});
export type StoredRun = z.infer<typeof StoredRunSchema>;
/** Tenant and creator identity remain persistence/audit fields, not API response data. */
export const ResearchRunViewSchema = StoredRunSchema.omit({ organizationId: true, createdBy: true });
export type ResearchRunView = z.infer<typeof ResearchRunViewSchema>;

const MemoryRecordFieldsSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(["short_term", "long_term", "research"]),
  tenantId: z.string().min(1),
  userId: z.string().nullable(),
  /** Short-term records are strictly scoped to one conversation. */
  conversationId: z.string().uuid().nullable().default(null),
  visibility: z.enum(["private", "organization"]),
  content: z.string().min(1),
  sourceRunId: z.string().uuid().nullable(),
  expiresAt: z.string().datetime().nullable(),
  retentionPolicy: z.enum(["session", "user_managed", "organization_default", "legal_hold"]).default("organization_default"),
  metadata: z.record(z.unknown()).default({}),
});

export const MemoryRecordSchema = MemoryRecordFieldsSchema.superRefine((record, context) => {
  if (record.scope !== "short_term") return;
  if (!record.conversationId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["conversationId"], message: "short-term memory requires a conversation id" });
  if (record.userId === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["userId"], message: "short-term memory requires a user" });
  if (record.visibility !== "private") context.addIssue({ code: z.ZodIssueCode.custom, path: ["visibility"], message: "short-term memory must be private" });
  if (record.retentionPolicy !== "session") context.addIssue({ code: z.ZodIssueCode.custom, path: ["retentionPolicy"], message: "short-term memory requires the session retention policy" });
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

/**
 * A publication candidate is not durable memory until the report/run
 * finalization transaction commits. It deliberately has no caller-supplied ID.
 */
export const ResearchMemoryPublicationSchema = MemoryRecordFieldsSchema.omit({ id: true }).extend({
  scope: z.literal("research"),
  userId: z.literal(null),
  conversationId: z.literal(null),
  visibility: z.literal("organization"),
  sourceRunId: z.string().uuid(),
  expiresAt: z.literal(null),
  retentionPolicy: z.literal("organization_default"),
});
export type ResearchMemoryPublication = z.infer<typeof ResearchMemoryPublicationSchema>;

/**
 * Metadata-only lead from a previously published report. It can broaden
 * retrieval/planning but is never admissible as factual claim evidence.
 */
export const ResearchMemoryHintSchema = z.object({
  sourceRunId: z.string().uuid(),
  question: z.string().min(1).max(4_000),
  entities: z.array(z.string().trim().min(1).max(160)).max(10),
  tickers: z.array(z.string().regex(/^[A-Z.]{1,10}$/)).max(10),
  asOfDates: z.array(z.string().date()).max(100),
});
export type ResearchMemoryHint = z.infer<typeof ResearchMemoryHintSchema>;

/**
 * The only long-term user preferences that can be persisted from the API.
 * This deliberately excludes inferred investor profiles, free-form notes, and
 * anything that could be mistaken for a source-backed research fact.
 */
export const ConfirmedPreferenceSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("valuation_method"), value: z.enum(["DCF", "comparable_companies", "precedent_transactions", "blended"]) }).strict(),
  z.object({ key: z.literal("focus_industries"), value: z.array(z.string().trim().min(1).max(80)).min(1).max(20) }).strict(),
  z.object({ key: z.literal("comparison_framework"), value: z.string().trim().min(1).max(160) }).strict(),
  z.object({ key: z.literal("display_unit"), value: z.enum(["USD", "USD thousands", "USD millions", "USD billions", "percentage", "basis points"]) }).strict(),
]);
export type ConfirmedPreference = z.infer<typeof ConfirmedPreferenceSchema>;

/** Explicit opt-in is required; preferences are never inferred from a turn. */
export const SaveConfirmedPreferenceSchema = z.object({
  preference: ConfirmedPreferenceSchema,
}).strict();
export type SaveConfirmedPreference = z.infer<typeof SaveConfirmedPreferenceSchema>;

/** Append-only audit record for a user-initiated memory deletion workflow. */
export const MemoryDeletionAuditSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().min(1),
  memoryId: z.string().uuid(),
  actorUserId: z.string().min(1).nullable(),
  memoryScope: z.enum(["short_term", "long_term", "research"]),
  sourceRunId: z.string().uuid().nullable(),
  evidenceIds: z.array(z.string().uuid()).max(1_000),
  eventType: z.enum(["requested", "completed", "failed"]),
  occurredAt: z.string().datetime(),
});
export type MemoryDeletionAudit = z.infer<typeof MemoryDeletionAuditSchema>;

export const CreateConversationSchema = z.object({ title: z.string().min(1).max(140).optional() }).strict();
export const UpdateConversationSchema = z.object({ title: z.string().min(1).max(140) }).strict();
export const CreateTurnSchema = z.object({ question: z.string().min(1).max(12_000) }).strict();

/** Route parameters are independently validated at every HTTP boundary. */
export const ConversationIdParamsSchema = z.object({ conversationId: z.string().uuid() });
export const ConversationPageCursorSchema = z.string().min(1).max(128).superRefine((value, context) => {
  const [snapshotAt, updatedAt, id, extra] = value.split("|");
  if (!snapshotAt || !updatedAt || !id || extra !== undefined || !z.string().datetime().safeParse(snapshotAt).success || !z.string().datetime().safeParse(updatedAt).success || !z.string().uuid().safeParse(id).success) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "cursor must contain snapshot timestamp, position timestamp, and UUID" });
  }
});
export type ConversationPageCursor = z.infer<typeof ConversationPageCursorSchema>;
export const ConversationListQuerySchema = z.object({
  archived: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: ConversationPageCursorSchema.optional(),
}).strict();
export const RunIdParamsSchema = z.object({ runId: z.string().uuid() });
export const EvidenceIdParamsSchema = z.object({ evidenceId: z.string().uuid() });
export const MemoryIdParamsSchema = z.object({ memoryId: z.string().uuid() });
export const ReportIdParamsSchema = z.object({ reportId: z.string().uuid() });

/** Public DTOs consumed by the web client; they intentionally exclude internal metadata. */
export const CreatedConversationSchema = z.object({ id: z.string().uuid() });
export type CreatedConversation = z.infer<typeof CreatedConversationSchema>;
export const ConversationViewSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});
export type ConversationView = z.infer<typeof ConversationViewSchema>;
export const ConversationListResponseSchema = z.object({ conversations: z.array(ConversationViewSchema), nextCursor: ConversationPageCursorSchema.nullable() }).strict();
export type ConversationListResponse = z.infer<typeof ConversationListResponseSchema>;
export const ConversationMessageViewSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  runId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
});
export type ConversationMessageView = z.infer<typeof ConversationMessageViewSchema>;
export const ConversationDetailViewSchema = z.object({
  conversation: ConversationViewSchema,
  messages: z.array(ConversationMessageViewSchema),
});
export type ConversationDetailView = z.infer<typeof ConversationDetailViewSchema>;
export const EvidenceViewSchema = EvidenceItemSchema.pick({
  id: true,
  title: true,
  content: true,
  locator: true,
  sourceUrl: true,
  asOfDate: true,
  license: true,
});
export type EvidenceView = z.infer<typeof EvidenceViewSchema>;
export const PreferenceListResponseSchema = z.object({ preferences: z.array(ConfirmedPreferenceSchema) });
export const PreferenceResponseSchema = z.object({ preference: ConfirmedPreferenceSchema });

/** Commands queued before the v2 tool-snapshot boundary, retained only to drain old work. */
const LegacyResearchRunCommandSchema = z.object({
  version: z.literal("v1"),
  runId: z.string().uuid(),
  conversationId: z.string().uuid(),
  scope: ResearchScopeSchema,
  question: z.string().min(1).max(12_000),
  requestedAt: z.string().datetime(),
});

/** Immutable, validated hand-off from the API outbox to a research worker. */
const ResearchRunCommandV2Schema = z.object({
  version: z.literal("v2"),
  runId: z.string().uuid(),
  conversationId: z.string().uuid(),
  scope: ResearchScopeSchema,
  question: z.string().min(1).max(12_000),
  /**
   * The API captures the authorized, agent-visible tool configuration before
   * queueing a run. Workers must execute against this immutable allowlist so
   * recovery cannot silently pick up a newly deployed tool or provider
   * version. Internal runtime tools are intentionally excluded.
   */
  toolManifestSnapshot: AgentToolManifestSnapshotSchema,
  requestedAt: z.string().datetime(),
});
export const ResearchRunCommandSchema = z.discriminatedUnion("version", [LegacyResearchRunCommandSchema, ResearchRunCommandV2Schema]);
export type ResearchRunCommand = z.infer<typeof ResearchRunCommandSchema>;

export const OutboxEventSchema = z.object({
  id: z.string().uuid(),
  type: z.literal("research_run_requested"),
  payload: ResearchRunCommandSchema,
  occurredAt: z.string().datetime(),
  attempts: z.number().int().nonnegative(),
});
export type OutboxEvent = z.infer<typeof OutboxEventSchema>;

export const ReportCitationSchema = z.object({
  number: z.number().int().positive(), evidenceId: z.string().uuid(), title: z.string().min(1), locator: z.string().min(1), sourceUrl: HttpSourceUrlSchema.nullable(), asOfDate: z.string().date().nullable(), license: z.string().min(1),
});
export type ReportCitation = z.infer<typeof ReportCitationSchema>;
export const ResearchReportSchema = z.object({
  id: z.string().uuid(), runId: z.string().uuid(), organizationId: z.string().min(1), version: z.number().int().positive(), markdown: z.string().min(1), citations: z.array(ReportCitationSchema), createdAt: z.string().datetime(),
});
export type ResearchReport = z.infer<typeof ResearchReportSchema>;
/** Tenant identity remains server-side; this is the report projection delivered to the browser. */
export const ResearchReportViewSchema = ResearchReportSchema.omit({ organizationId: true });
export type ResearchReportView = z.infer<typeof ResearchReportViewSchema>;
export const CreateReportSchema = z.object({ runId: z.string().uuid() }).strict();

export const ApiErrorSchema = z.object({ code: z.string(), message: z.string(), requestId: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;
