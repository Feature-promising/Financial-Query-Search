import { createHash } from "node:crypto";
import {
  ResearchRunSchema,
  ResearchPlanSchema,
  ResearchMemoryHintSchema,
  ResearchMemoryPublicationSchema,
  RunCostBudgetExceeded,
  RunCostLedger,
  publicToolFailure,
  type NewRunEvent,
  type RunEventPayload,
  type ResearchScope,
  type RunBudget,
  type RunEvent,
} from "@research/contracts";
import { emptyPrioritizedMemoryContext, loadPrioritizedMemoryContext, renderConfirmedPreferenceContent, toConfirmedPreference, type MemoryStore } from "@research/memory";
import type { ReportToolInput, ReportToolOutput, ToolRegistry } from "@research/tools";
import { dcfInputFromEvidence } from "@research/tools";
import type { EvidenceRepository } from "@research/knowledge";
import { SafeClaimComposer } from "./claims.js";
import type { RunTracer } from "@research/observability";
import { critic, normalizeEvidence } from "./critic.js";
import { proposeCriticRepair } from "./repair.js";
import { RuleBasedIntentAnalyzer } from "./intent.js";
import { DefaultPlanner } from "./planner.js";
import { restrictPlanToAuthorizedTools } from "./plan-policy.js";
import { RunDeadlineExceeded, RunShutdownRequested } from "./runtime-errors.js";
import type { ClaimComposer, ClaimEntailmentVerifier, IntentAnalyzer, Planner, ResearchPhase, ResearchRunInput, ResearchRunResult, ResearchRuntimeSession, ResearchState, RunCheckpointSink, RunEventSink } from "./types.js";

export interface ResearchRuntimeDependencies {
  tools: ToolRegistry;
  memories: MemoryStore;
  events: RunEventSink;
  intentAnalyzer?: IntentAnalyzer;
  planner?: Planner;
  claimComposer?: ClaimComposer;
  claimEntailmentVerifier?: ClaimEntailmentVerifier;
  evidenceRepository?: EvidenceRepository;
  checkpoints?: RunCheckpointSink;
  tracer?: RunTracer;
  /** Shared with model invocation context in production. */
  costLedger?: RunCostLedger;
}

export class ResearchRuntime {
  private readonly activeSessions = new Map<string, ResearchRuntimeSession>();

  constructor(private readonly dependencies: ResearchRuntimeDependencies) {}

  async run(input: ResearchRunInput): Promise<ResearchRunResult> {
    return this.withRunTrace(input, () => this.runUntraced(input));
  }

  /** Keeps the top-level trace intact when LangGraph owns the phase ordering. */
  async withRunTrace<T>(input: ResearchRunInput, operation: () => Promise<T>): Promise<T> {
    if (this.dependencies.tracer) return this.dependencies.tracer.span("research.run", { runId: input.runId, conversationId: input.conversationId }, operation);
    return operation();
  }

  /** Creates a non-persisted execution session for the explicit LangGraph phases. */
  createSession(input: ResearchRunInput): ResearchRuntimeSession {
    const state = this.createInitialState(input);
    const abortController = new AbortController();
    const deadline = Date.now() + state.budget.maxRunDurationMs;
    const deadlineTimer = setTimeout(() => abortController.abort(new RunDeadlineExceeded()), state.budget.maxRunDurationMs);
    deadlineTimer.unref?.();
    const requestShutdown = () => abortController.abort(new RunShutdownRequested());
    if (input.shutdownSignal?.aborted) requestShutdown();
    else input.shutdownSignal?.addEventListener("abort", requestShutdown, { once: true });
    const session: ResearchRuntimeSession = {
      input,
      state,
      usage: {
        deadline, toolCalls: 0, toolManifestSnapshot: input.toolManifestSnapshot, abortController, deadlineTimer,
        detachShutdownSignal: input.shutdownSignal ? () => input.shutdownSignal?.removeEventListener("abort", requestShutdown) : undefined,
      },
      costLedger: this.dependencies.costLedger ?? new RunCostLedger(state.budget.maxEstimatedCostUsd),
    };
    this.activeSessions.set(input.runId, session);
    return session;
  }

  /** Clears the deadline timer after either terminal branch has persisted. */
  closeSession(session: ResearchRuntimeSession): void {
    clearTimeout(session.usage.deadlineTimer);
    session.usage.detachShutdownSignal?.();
    this.activeSessions.delete(session.input.runId);
  }

  closeRunSession(runId: string): void {
    const session = this.activeSessions.get(runId);
    if (session) this.closeSession(session);
  }

  /** Lets LangGraph distinguish a run-level refusal from an unexpected failure. */
  isRunDeadlineExceeded(session: ResearchRuntimeSession, error: unknown): boolean {
    return error instanceof RunDeadlineExceeded
      || session.usage.abortController.signal.reason instanceof RunDeadlineExceeded
      || Date.now() >= session.usage.deadline;
  }

  /** Lets LangGraph route an infrastructure drain to an auditable abstention. */
  isRunShutdownRequested(session: ResearchRuntimeSession, error: unknown): boolean {
    return error instanceof RunShutdownRequested || session.usage.abortController.signal.reason instanceof RunShutdownRequested;
  }

  async start(session: ResearchRuntimeSession): Promise<void> {
    this.assertWithinDeadline(session);
    await this.emit(session.state, "run_started", { question: session.input.question });
    this.assertWithinDeadline(session);
  }

  async loadContextPhase(session: ResearchRuntimeSession): Promise<void> {
    this.assertWithinDeadline(session);
    await this.loadContext(session.state, session.input.scope);
    this.assertWithinDeadline(session);
    await this.checkpoint(session.state, "context_loaded");
  }

  async analyzeIntentPhase(session: ResearchRuntimeSession): Promise<void> {
    this.assertWithinDeadline(session);
    await this.analyzeIntent(session.state, session.usage.abortController.signal);
    this.assertWithinDeadline(session);
    await this.checkpoint(session.state, "intent_analyzed");
  }

  async planResearchPhase(session: ResearchRuntimeSession): Promise<void> {
    this.assertWithinDeadline(session);
    await this.planResearch(session.state, session.input.question, session.usage.abortController.signal);
    this.assertWithinDeadline(session);
    await this.checkpoint(session.state, "planned");
  }

  async executeTasksPhase(session: ResearchRuntimeSession): Promise<void> {
    this.assertWithinDeadline(session);
    await this.executeTasks(session.state, session.input.scope, session.usage, session.costLedger);
    this.assertWithinDeadline(session);
    await this.checkpoint(session.state, "tasks_executed");
  }

  /** Isolates evidence normalization/persistence before any model can compose claims. */
  async buildEvidencePhase(session: ResearchRuntimeSession): Promise<void> {
    this.assertWithinDeadline(session);
    await this.buildEvidence(session.state);
    this.assertWithinDeadline(session);
    await this.checkpoint(session.state, "evidence_built");
  }

  /** Generates evidence-bound claims only after the bounded context is durable and normalized. */
  async composeClaimsPhase(session: ResearchRuntimeSession): Promise<void> {
    this.assertWithinDeadline(session);
    await this.composeClaims(session.state, session.usage.abortController.signal);
    this.assertWithinDeadline(session);
    await this.checkpoint(session.state, "claims_composed");
  }

  async criticPhase(session: ResearchRuntimeSession): Promise<void> {
    this.assertWithinDeadline(session);
    await this.criticizeAndRepair(session.state, session.input.scope, session.usage, session.costLedger);
    this.assertWithinDeadline(session);
    await this.checkpoint(session.state, "critic_completed");
  }

  async publishPhase(session: ResearchRuntimeSession): Promise<ResearchRunResult> {
    const result = await this.publish(session.state, session.usage);
    await this.checkpoint(session.state, "published");
    return result;
  }

  /** Safe terminal transition used when a billable model reservation is refused. */
  async costBudgetExceededPhase(session: ResearchRuntimeSession): Promise<ResearchRunResult> {
    const state = session.state;
    state.criticResult = { publishable: false, reason: "Run cost budget was exhausted; publication was refused.", rejectedClaimIds: state.claims.map((claim) => claim.id) };
    await this.emit(state, "critic_result", { ...state.criticResult, phase: "cost_budget_exhausted" });
    return this.publishPhase(session);
  }

  /** Terminal deadline path: preserve the audit trace but never publish research claims. */
  async deadlineExceededPhase(session: ResearchRuntimeSession): Promise<ResearchRunResult> {
    const state = session.state;
    state.criticResult = { publishable: false, reason: "Run time budget was exhausted; publication was refused.", rejectedClaimIds: state.claims.map((claim) => claim.id) };
    await this.emit(state, "critic_result", { ...state.criticResult, phase: "run_deadline_exceeded" });
    return this.publishPhase(session);
  }

  /** Stops provider work on worker drain without pretending that research completed. */
  async shutdownPhase(session: ResearchRuntimeSession): Promise<ResearchRunResult> {
    const state = session.state;
    state.criticResult = { publishable: false, reason: "Worker shutdown interrupted research; publication was refused.", rejectedClaimIds: state.claims.map((claim) => claim.id) };
    await this.emit(state, "critic_result", { ...state.criticResult, phase: "worker_shutdown" });
    return this.publishPhase(session);
  }

  private async runUntraced(input: ResearchRunInput): Promise<ResearchRunResult> {
    const session = this.createSession(input);
    try {
      await this.start(session);
      await this.loadContextPhase(session);
      await this.analyzeIntentPhase(session);
      await this.planResearchPhase(session);
      await this.executeTasksPhase(session);
      await this.buildEvidencePhase(session);
      await this.composeClaimsPhase(session);
      await this.criticPhase(session);
      return this.publishPhase(session);
    } catch (error) {
      if (error instanceof RunCostBudgetExceeded) return this.costBudgetExceededPhase(session);
      if (this.isRunShutdownRequested(session, error)) return this.shutdownPhase(session);
      if (this.isRunDeadlineExceeded(session, error)) return this.deadlineExceededPhase(session);
      throw error;
    } finally { this.closeSession(session); }
  }

  private createInitialState(input: ResearchRunInput): ResearchState {
    return {
      run: ResearchRunSchema.parse({ id: input.runId, conversationId: input.conversationId, scope: input.scope, question: input.question, status: "running", budget: input.budget, startedAt: new Date().toISOString(), finishedAt: null }),
      conversation: { conversationId: input.conversationId, recentMessages: input.recentMessages ?? [], memories: emptyPrioritizedMemoryContext() },
      tasks: [], evidence: [], claims: [], budget: input.budget, criticRepairs: 0,
    };
  }

  private async loadContext(state: ResearchState, scope: ResearchScope): Promise<void> {
    state.conversation.memories = await loadPrioritizedMemoryContext(this.dependencies.memories, {
      tenantId: scope.organizationId,
      userId: scope.userId,
      conversationId: state.conversation.conversationId,
      question: state.run.question,
    });
  }

  private async analyzeIntent(state: ResearchState, signal: AbortSignal): Promise<void> {
    state.intent = await (this.dependencies.intentAnalyzer ?? new RuleBasedIntentAnalyzer()).analyze(state.run.question, signal);
    await this.emit(state, "intent_ready", state.intent!);
  }

  private async planResearch(state: ResearchState, question: string, signal: AbortSignal): Promise<void> {
    const manifests = this.authorizedToolManifests(state);
    const rawPlan = await (this.dependencies.planner ?? new DefaultPlanner()).plan(state.intent!, question, state.budget, signal, {
      recentMessages: state.conversation.recentMessages.slice(-12),
      // Do not forward stored content/metadata verbatim: only the closed,
      // revalidated preference payload is eligible for a model prompt.
      userPreferences: state.conversation.memories.userPreferences.flatMap((record) => {
        const preference = toConfirmedPreference(record);
        return preference ? [{
          content: renderConfirmedPreferenceContent(preference),
          metadata: { userConfirmed: true, preferenceKey: preference.key, preferenceValue: preference.value },
        }] : [];
      }),
      availableToolIds: manifests.map((manifest) => manifest.id),
      researchMemoryHints: this.researchMemoryHints(state),
    });
    // Planner implementations are provider boundaries. Re-validate even a
    // TypeScript-typed custom adapter before the task reaches tools/costs.
    state.plan = restrictPlanToAuthorizedTools(ResearchPlanSchema.parse(rawPlan), manifests);
    state.tasks = state.plan.tasks;
    await this.emit(state, "plan_ready", { summary: state.plan.summary, tasks: state.tasks });
  }

  /** V2 uses the immutable command snapshot; direct development runs share the registry policy. */
  private authorizedToolManifests(state: ResearchState) {
    const manifests = this.activeSessions.get(state.run.id)?.input.toolManifestSnapshot
      ?? this.dependencies.tools.discover(state.run.scope);
    return manifests.filter((manifest) => manifest.enabled && manifest.visibility !== "internal"
      && manifest.requiredEntitlements.every((entitlement) => state.run.scope.entitlements.includes(entitlement)));
  }

  private async executeTasks(state: ResearchState, scope: ResearchScope, usage: ResearchRuntimeSession["usage"], costLedger: RunCostLedger): Promise<void> {
    while (state.tasks.some((task) => task.status === "pending")) {
      if (Date.now() >= usage.deadline || usage.toolCalls >= state.budget.maxToolCalls || costLedger.exhausted) {
        this.skipPending(state.tasks);
        break;
      }
      const runnable = state.tasks.filter((task) => task.status === "pending" && task.dependsOn.every((id) => state.tasks.find((candidate) => candidate.id === id)?.status === "completed"));
      if (runnable.length === 0) {
        this.skipPending(state.tasks);
        break;
      }
      const batch = runnable.slice(0, state.budget.maxToolCalls - usage.toolCalls);
      usage.toolCalls += batch.length;
      // A budget refusal in one parallel task must not let the graph publish
      // while another already-started provider call is still settling. Wait
      // for the whole batch, then propagate the first terminal failure.
      const outcomes = await Promise.allSettled(batch.map((task) => this.executeTask(
        state, task, scope, Math.max(1, state.budget.maxToolCalls - usage.toolCalls + 1), costLedger,
        usage.abortController.signal, usage.toolManifestSnapshot,
      )));
      const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (rejected) throw rejected.reason;
      this.assertUsageWithinDeadline(usage);
    }
  }

  private async executeTask(
    state: ResearchState,
    task: ResearchState["tasks"][number],
    scope: ResearchScope,
    remainingToolCalls: number,
    costLedger: RunCostLedger,
    signal: AbortSignal,
    toolManifestSnapshot: ResearchRuntimeSession["usage"]["toolManifestSnapshot"],
  ): Promise<void> {
    const toolId = task.allowedTools[0];
    const input = this.buildToolInput(toolId, state, task);
    if (!input) {
      task.status = "failed";
      await this.emit(state, "tool_completed", {
        taskId: task.id,
        toolId,
        ok: false,
        failure: {
          code: "INVALID_INPUT",
          message: toolId === "analysis.dcf"
            ? "DCF requires one licensed, source-bound valuation-input record from this run."
            : "No validated tool input is available for this task.",
          retryable: false,
        },
        estimatedCostUsd: 0,
      });
      return;
    }
    task.status = "running";
    await this.emit(state, "task_started", { taskId: task.id, title: task.title });
    const invoke = () => this.dependencies.tools.invoke(toolId, input, {
      runId: state.run.id, scope, toolManifestSnapshot, remainingToolCalls,
      idempotencyKey: toolInvocationKey(state.run.id, task.id, toolId), signal, costLedger,
    });
    const result = this.dependencies.tracer
      ? await this.dependencies.tracer.span("research.tool", { runId: state.run.id, taskId: task.id, toolId }, invoke)
      : await invoke();
    if (result.ok) {
      state.evidence.push(...result.evidence);
      task.status = "completed";
    } else task.status = "failed";
    await this.emit(state, "tool_completed", { taskId: task.id, toolId, ok: result.ok, failure: result.ok ? undefined : publicToolFailure(result.failure), estimatedCostUsd: result.estimatedCostUsd });
    if (!result.ok && result.failure.code === "BUDGET_EXCEEDED") throw new RunCostBudgetExceeded();
    return;
  }

  /** Builds tool arguments only from run state; it never promotes model text into financial assumptions. */
  private buildToolInput(toolId: string, state: ResearchState, task: ResearchState["tasks"][number]): unknown | undefined {
    const requestedDate = state.intent?.period?.match(/^20\d{2}-\d{2}-\d{2}$/)?.[0];
    const query = this.queryWithVerifiedTicker(state);
    if (toolId === "filing.search") return { query, period: state.intent?.period ?? undefined };
    if (toolId === "financial.get") {
      return state.intent?.category === "valuation" && task.id === "financials"
        ? { query, template: "valuation_inputs", asOfDate: requestedDate }
        : { query, asOfDate: requestedDate };
    }
    if (toolId === "retrieval.search") return { query, entities: this.retrievalEntities(state), asOfDate: requestedDate, researchMemorySeeds: this.researchMemoryHints(state) };
    if (toolId !== "analysis.dcf") return { query };
    const candidates = new Set([
      ...(state.intent?.tickers ?? []),
      ...(state.run.question.match(/\b[A-Z]{1,5}\b/g) ?? []),
    ]);
    for (const ticker of candidates) {
      const input = dcfInputFromEvidence(state.evidence, ticker);
      if (input) return input;
    }
    return undefined;
  }

  /** Places a validated ticker ahead of free text so source tools do not guess from prose. */
  private queryWithVerifiedTicker(state: ResearchState): string {
    const ticker = state.intent?.tickers[0];
    return ticker ? `${ticker} ${state.run.question}` : state.run.question;
  }

  /** Supplies the Hybrid RAG graph expansion with bounded, Intent-validated entities. */
  private retrievalEntities(state: ResearchState): string[] | undefined {
    const entities = [...new Set([...(state.intent?.tickers ?? []), ...(state.intent?.entities ?? [])])]
      .filter((entity) => entity.trim().length > 0)
      .slice(0, 10);
    return entities.length ? entities : undefined;
  }

  /** Converts historical reports into validated retrieval leads without exposing report body as model context. */
  private researchMemoryHints(state: ResearchState) {
    return state.conversation.memories.researchAssets.flatMap((record) => ResearchMemoryHintSchema.safeParse({
      sourceRunId: record.sourceRunId,
      question: record.metadata.question,
      entities: record.metadata.entities,
      tickers: record.metadata.tickers,
      asOfDates: record.metadata.asOfDates,
    }).data ?? []).slice(0, 4);
  }

  private skipPending(tasks: ResearchState["tasks"]): void {
    for (const task of tasks) if (task.status === "pending") task.status = "skipped";
  }

  private async criticizeAndRepair(state: ResearchState, scope: ResearchScope, usage: ResearchRuntimeSession["usage"], costLedger: RunCostLedger): Promise<void> {
    const initial = await this.evaluateCritic(state, usage.abortController.signal);
    const proposedRepair = this.canRunRepair(state, usage, costLedger) ? proposeCriticRepair(state, initial) : undefined;
    const repair = proposedRepair && this.isTaskAuthorized(proposedRepair.task, this.authorizedToolManifests(state)) ? proposedRepair : undefined;
    await this.emit(state, "critic_result", { ...initial, phase: "initial", repairScheduled: Boolean(repair), repairReason: repair?.reason });
    if (!repair) return;
    state.criticRepairs += 1;
    state.tasks.push(repair.task);
    await this.executeTasks(state, scope, usage, costLedger);
    await this.buildEvidence(state);
    await this.composeClaims(state, usage.abortController.signal);
    const final = await this.evaluateCritic(state, usage.abortController.signal);
    await this.emit(state, "critic_result", { ...final, phase: "after_repair", repairAttempt: state.criticRepairs });
  }

  private canRunRepair(state: ResearchState, usage: ResearchRuntimeSession["usage"], costLedger: RunCostLedger): boolean {
    return Date.now() < usage.deadline
      && usage.toolCalls < state.budget.maxToolCalls
      && !costLedger.exhausted;
  }

  private isTaskAuthorized(task: ResearchState["tasks"][number], manifests: Array<{ id: string }>): boolean {
    const authorized = new Set(manifests.map((manifest) => manifest.id));
    return task.allowedTools.some((toolId) => authorized.has(toolId));
  }

  private async buildEvidence(state: ResearchState): Promise<void> {
    state.evidence = normalizeEvidence(state.evidence, state.run.scope.organizationId);
    if (this.dependencies.evidenceRepository && state.evidence.length) {
      const pending = state.evidence.filter((item) => typeof item.metadata.evidenceUri !== "string");
      const persisted = await this.dependencies.evidenceRepository.store(pending);
      const persistedById = new Map(persisted.map((item) => [item.id, item]));
      state.evidence = state.evidence.map((item) => persistedById.get(item.id) ?? item);
    }
    await this.emit(state, "evidence_ready", { count: state.evidence.length });
  }

  private async composeClaims(state: ResearchState, signal: AbortSignal): Promise<void> {
    state.claims = await (this.dependencies.claimComposer ?? new SafeClaimComposer()).compose(state.evidence, state, signal);
    for (const claim of state.claims) await this.emit(state, "claim_delta", claim);
  }

  private async evaluateCritic(state: ResearchState, signal: AbortSignal): Promise<NonNullable<ResearchState["criticResult"]>> {
    state.criticResult = critic(state);
    if (state.criticResult.publishable && this.dependencies.claimEntailmentVerifier) {
      try {
        state.criticResult = applyEntailmentResult(
          state.criticResult,
          state.claims,
          await this.dependencies.claimEntailmentVerifier.verify(state.claims, state.evidence, state.run.scope, signal),
        );
      } catch {
        state.criticResult = {
          publishable: false,
          reason: "Citation entailment verification was unavailable; publication was refused.",
          rejectedClaimIds: state.claims.map((claim) => claim.id),
        };
      }
    }
    return state.criticResult;
  }

  private async publish(state: ResearchState, usage: ResearchRuntimeSession["usage"]): Promise<ResearchRunResult> {
    let publishable = state.criticResult!.publishable;
    let report: ResearchRunResult["report"];
    if (publishable) {
      const rendered = await this.renderReport(state, usage);
      if (rendered.ok) report = rendered.document;
      else {
        publishable = false;
        state.criticResult = {
          publishable: false,
          reason: rendered.reason,
          rejectedClaimIds: state.claims.map((claim) => claim.id),
        };
        await this.emit(state, "critic_result", { ...state.criticResult, phase: "report_rendering" });
      }
    }
    const status = publishable ? "completed" : "abstained";
    state.run = ResearchRunSchema.parse({ ...state.run, status, finishedAt: new Date().toISOString() });
    const answer = publishable && report
      ? report.markdown
      : `无法可靠完成此研究：${state.criticResult!.reason}`;
    const researchMemory = publishable
      ? ResearchMemoryPublicationSchema.parse({
        scope: "research", tenantId: state.run.scope.organizationId, userId: null, conversationId: null, visibility: "organization", content: answer,
        sourceRunId: state.run.id, expiresAt: null, retentionPolicy: "organization_default",
        metadata: {
          researchMemoryVersion: 1,
          question: state.run.question,
          entities: state.intent?.entities ?? [],
          tickers: state.intent?.tickers ?? [],
          evidenceIds: state.evidence.map((item) => item.id),
          asOfDates: state.evidence.map((item) => item.asOfDate).filter((value): value is string => value !== null),
          claimCount: state.claims.length,
          publishedAt: state.run.finishedAt,
        },
      })
      : undefined;
    await this.emit(state, publishable ? "completed" : "abstained", { answer, evidenceCount: state.evidence.length });
    return { state, answer, status, report, researchMemory };
  }

  /** Invokes the internal-only report tool so composition shares authorization and audit controls. */
  private async renderReport(state: ResearchState, usage: ResearchRuntimeSession["usage"]): Promise<{ ok: true; document: NonNullable<ResearchRunResult["report"]> } | { ok: false; reason: string }> {
    const result = await this.dependencies.tools.invoke<ReportToolInput, ReportToolOutput>("report.compose", {
      question: state.run.question,
      claims: state.claims,
      evidence: state.evidence,
    }, {
      runId: state.run.id,
      scope: state.run.scope,
      // This fixed, deterministic post-Critic render is not an autonomous
      // external-tool call. It runs at most once and never consumes the
      // planner/executor budget reserved for evidence collection.
      remainingToolCalls: 1,
      idempotencyKey: toolInvocationKey(state.run.id, "publish_report", "report.compose"),
      signal: usage.abortController.signal,
    });
    if (!result.ok) {
      await this.emit(state, "tool_completed", { taskId: "publish_report", toolId: "report.compose", ok: false, failure: publicToolFailure(result.failure), estimatedCostUsd: result.estimatedCostUsd });
      return { ok: false, reason: "Controlled report rendering failed before publication." };
    }
    await this.emit(state, "tool_completed", { taskId: "publish_report", toolId: "report.compose", ok: true, estimatedCostUsd: result.estimatedCostUsd });
    return { ok: true, document: { markdown: result.value.markdown, citations: result.value.citations } };
  }

  private async emit<T extends RunEvent["type"]>(state: ResearchState, type: T, payload: RunEventPayload<T>): Promise<void> {
    await this.dependencies.events.append({ runId: state.run.id, type, at: new Date().toISOString(), payload } as Extract<NewRunEvent, { type: T }>);
  }

  private async checkpoint(state: ResearchState, phase: ResearchPhase): Promise<void> {
    await this.dependencies.checkpoints?.save({
      runId: state.run.id,
      organizationId: state.run.scope.organizationId,
      phase,
      snapshot: { intent: state.intent, plan: state.plan, tasks: state.tasks, evidenceIds: state.evidence.map((item) => item.id), claims: state.claims, criticRepairs: state.criticRepairs, criticResult: state.criticResult },
      createdAt: new Date().toISOString(),
    });
  }

  private assertWithinDeadline(session: ResearchRuntimeSession): void {
    if (this.isRunShutdownRequested(session, undefined)) throw new RunShutdownRequested();
    if (this.isRunDeadlineExceeded(session, undefined)) throw new RunDeadlineExceeded();
  }

  private assertUsageWithinDeadline(usage: ResearchRuntimeSession["usage"]): void {
    if (usage.abortController.signal.reason instanceof RunShutdownRequested) throw new RunShutdownRequested();
    if (usage.abortController.signal.aborted || Date.now() >= usage.deadline) throw new RunDeadlineExceeded();
  }
}

export function defaultBudget(): RunBudget {
  return { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 };
}

function applyEntailmentResult(
  result: NonNullable<ResearchState["criticResult"]>,
  claims: ResearchState["claims"],
  verdicts: Array<{ claimId: string; supported: boolean; reason?: string }>,
): NonNullable<ResearchState["criticResult"]> {
  const verdictByClaim = new Map(verdicts.map((verdict) => [verdict.claimId, verdict]));
  const rejectedClaimIds = claims
    .filter((claim) => verdictByClaim.get(claim.id)?.supported !== true)
    .map((claim) => claim.id);
  if (rejectedClaimIds.length === 0) return result;
  return {
    publishable: false,
    reason: "One or more claims failed citation entailment verification.",
    rejectedClaimIds: [...new Set([...result.rejectedClaimIds, ...rejectedClaimIds])],
  };
}

/** Stable across queue redelivery; task IDs are validated planner output. */
function toolInvocationKey(runId: string, taskId: string, toolId: string): string {
  return `task:${createHash("sha256").update(`${runId}\u0000${taskId}\u0000${toolId}`).digest("hex")}`;
}
