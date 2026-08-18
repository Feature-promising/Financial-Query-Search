import { randomUUID } from "node:crypto";
import { runResearchGraph, type ResearchRuntime, type RunEventSink } from "@research/agent-runtime";
import type { ConversationStore } from "@research/conversation";
import { markRunFailedIfActive, type RunStore } from "@research/runs";
import { RunCostLedger, RunEventSchema, RunRecoveredPayloadSchema, publicRunFailurePayload, runLeaseExpiredPayload, type NewRunEvent, type ResearchMemoryPublication, type RunEvent } from "@research/contracts";
import type { ReportStore } from "@research/reports";
import type { EvidenceStore } from "@research/knowledge";
import { withModelInvocationContext } from "@research/models";
import { decideRecovery, isAutomaticallyRecoverablePhase, isRecoveryCheckpointPhase } from "@research/agent-runtime";
import type { RunEventPublisher } from "@research/live-events";
import type { ResearchRunCommand } from "../commands/research-run.js";
import type { RunCommandHandler } from "./research-run-consumer.js";
import { RateLimitedLiveEventFailureReporter, type LiveEventFailureReporter } from "./live-event-failure-reporter.js";

/** Production may replace sequential adapters with one atomic publication commit. */
export interface ResearchRunPublicationFinalizer {
  finalize(scope: import("@research/contracts").ResearchScope, publication: {
    runId: string;
    ownerUserId: string;
    status: "completed" | "abstained";
    answer: string;
    report?: { markdown: string; citations: Array<unknown> };
    researchMemory?: ResearchMemoryPublication;
    terminalEvent: Extract<RunEvent, { type: "completed" | "abstained" }>;
  }): Promise<void>;
}

export interface ResearchRuntimeFactory {
  create(events: RunEventSink, command: ResearchRunCommand, costLedger?: RunCostLedger): ResearchRuntime;
}

/** Resolves the API-committed command before trusting a queue delivery. */
export interface ResearchRunCommandResolver {
  resolve(runId: string): Promise<ResearchRunCommand | undefined>;
}

export interface ResearchRunHandlerDependencies {
  conversations: ConversationStore;
  runs: RunStore;
  reports?: ReportStore;
  evidence?: EvidenceStore;
  finalizer?: ResearchRunPublicationFinalizer;
  checkpoints?: { latest(runId: string, organizationId: string): Promise<{ phase: string } | undefined> };
  liveEvents?: RunEventPublisher;
  liveEventFailureReporter?: LiveEventFailureReporter;
  commandResolver?: ResearchRunCommandResolver;
  runtime: ResearchRuntimeFactory;
}

/**
 * Owns durable run execution after a queue delivery. A run is atomically
 * claimed before execution, making at-least-once delivery safe for completed
 * commands. Event sequence allocation is serialized in this worker process.
 */
export class DurableResearchRunHandler implements RunCommandHandler {
  private readonly liveEventFailureReporter: LiveEventFailureReporter;

  constructor(private readonly dependencies: ResearchRunHandlerDependencies) {
    this.liveEventFailureReporter = dependencies.liveEventFailureReporter ?? new RateLimitedLiveEventFailureReporter();
  }

  async handle(deliveredCommand: ResearchRunCommand, shutdownSignal?: AbortSignal): Promise<void> {
    const command = await this.resolveCommand(deliveredCommand);
    const claim = await this.claimOrRecover(command);
    if (!claim.claimed) return;
    const run = await this.dependencies.runs.get(command.scope, command.runId);
    if (!run || run.conversationId !== command.conversationId || run.question !== command.question) {
      if (run) await this.dependencies.runs.finish(command.scope, command.runId, "failed");
      throw new Error("run command does not match its persisted research run");
    }
    const conversation = await this.dependencies.conversations.get(command.scope, command.conversationId);
    if (!conversation) throw new Error("run conversation not found");
    const history = await this.dependencies.conversations.listMessages(command.scope, command.conversationId);
    const sink = await PersistedRunEventSink.create(this.dependencies.runs, command, this.dependencies.liveEvents, this.liveEventFailureReporter, Boolean(this.dependencies.finalizer));
    // The API transaction persisted this bounded budget alongside the run.
    // Queue payloads are deliberately not trusted as an authority for it.
    const budget = run.budget;
    const costLedger = new RunCostLedger(budget.maxEstimatedCostUsd);
    try {
      if (claim.recovery) {
        await sink.append({
          runId: command.runId,
          type: "run_recovered",
          at: new Date().toISOString(),
          payload: RunRecoveredPayloadSchema.parse(claim.recovery),
        });
      }
      const runtime = this.dependencies.runtime.create(sink, command, costLedger);
      const result = await withModelInvocationContext({ runId: command.runId, organizationId: command.scope.organizationId, costLedger }, () => runResearchGraph(runtime, {
        runId: command.runId, conversationId: command.conversationId, question: command.question,
        scope: command.scope, budget,
        // v1 only drains pre-rollout queued work; all new submissions use v2.
        toolManifestSnapshot: command.version === "v2" ? command.toolManifestSnapshot : undefined,
        shutdownSignal,
        recentMessages: history.map((message) => ({ role: message.role, content: message.content })),
      }));
      if (result.state.evidence.length) {
        if (!this.dependencies.evidence) throw new Error("evidence store is required to publish cited research");
        await this.dependencies.evidence.save(command.scope, command.runId, result.state.evidence);
      }
      if (this.dependencies.finalizer) {
        const terminalEvent = await sink.takeDeferredTerminal();
        await this.dependencies.finalizer.finalize(command.scope, {
          runId: command.runId, ownerUserId: conversation.createdBy, status: result.status, answer: result.answer,
          ...(result.report ? { report: result.report } : {}),
          ...(result.researchMemory ? { researchMemory: result.researchMemory } : {}),
          terminalEvent,
        });
        await sink.commitDeferredTerminal(terminalEvent);
      } else {
        await this.dependencies.conversations.appendMessage(command.scope, { conversationId: command.conversationId, role: "assistant", content: result.answer, runId: command.runId });
        if (result.status === "completed") {
          if (!this.dependencies.reports) throw new Error("report store is required to publish completed research");
          if (!result.report) throw new Error("completed research run has no controlled report");
          await this.dependencies.reports.create(command.scope, { runId: command.runId, organizationId: command.scope.organizationId, ownerUserId: conversation.createdBy, markdown: result.report.markdown, citations: result.report.citations });
        }
        // Development adapters preserve the same report-before-terminal order.
        await this.dependencies.runs.finish(command.scope, command.runId, result.status, result.answer);
      }
    } catch (error) {
      // Failure-event persistence is intentionally best-effort. Even if its
      // store or live transport is down, close the lease so recovery policy
      // can make the next safe decision instead of waiting for expiration.
      try {
        await sink.append({ runId: command.runId, type: "failed", at: new Date().toISOString(), payload: publicRunFailurePayload() });
      } catch {
        // `markRunFailedIfActive` below is the durable terminal fallback.
      }
      await markRunFailedIfActive(this.dependencies.runs, command.scope, command.runId).catch(() => undefined);
      throw error;
    }
  }

  private async resolveCommand(deliveredCommand: ResearchRunCommand): Promise<ResearchRunCommand> {
    if (!this.dependencies.commandResolver) return deliveredCommand;
    const command = await this.dependencies.commandResolver.resolve(deliveredCommand.runId);
    if (!command) throw new Error("queued research run has no durable command");
    return command;
  }

  private async claimOrRecover(command: ResearchRunCommand): Promise<RunClaim> {
    if (await this.dependencies.runs.claim(command.scope, command.runId)) return { claimed: true };
    if (await this.dependencies.runs.expireStaleLease(command.scope, command.runId)) {
      await this.recordLeaseExpired(command);
    }
    const checkpoint = await this.dependencies.checkpoints?.latest(command.runId, command.scope.organizationId);
    if (!checkpoint || !isRecoveryCheckpointPhase(checkpoint.phase) || !isAutomaticallyRecoverablePhase(checkpoint.phase)) return { claimed: false };
    const decision = decideRecovery({ runId: command.runId, organizationId: command.scope.organizationId, phase: checkpoint.phase, snapshot: { tasks: [], evidenceIds: [], claims: [] }, createdAt: "" });
    if (!decision.automatic || !await this.dependencies.runs.requeueForRecovery(command.scope, command.runId)) return { claimed: false };
    if (!await this.dependencies.runs.claim(command.scope, command.runId)) return { claimed: false };
    return { claimed: true, recovery: { checkpointPhase: checkpoint.phase, reason: decision.reason } };
  }

  private async recordLeaseExpired(command: ResearchRunCommand): Promise<void> {
    const run = await this.dependencies.runs.get(command.scope, command.runId);
    if (!run) return;
    await this.dependencies.runs.appendEvent(command.scope, {
      id: randomUUID(),
      runId: command.runId,
      sequence: run.events.length + 1,
      type: "failed",
      at: new Date().toISOString(),
      payload: runLeaseExpiredPayload(),
    });
  }
}

interface RunClaim {
  claimed: boolean;
  recovery?: { checkpointPhase: "context_loaded" | "intent_analyzed" | "planned"; reason: string };
}

class PersistedRunEventSink implements RunEventSink {
  private pending = Promise.resolve();
  private deferredTerminal: Extract<NewRunEvent, { type: "completed" | "abstained" }> | undefined;

  private constructor(private readonly runs: RunStore, private readonly command: ResearchRunCommand, private readonly liveEvents: RunEventPublisher | undefined, private readonly liveEventFailureReporter: LiveEventFailureReporter, private sequence: number, private readonly deferTerminal: boolean) {}

  static async create(runs: RunStore, command: ResearchRunCommand, liveEvents: RunEventPublisher | undefined, liveEventFailureReporter: LiveEventFailureReporter, deferTerminal = false): Promise<PersistedRunEventSink> {
    const run = await runs.get(command.scope, command.runId);
    if (!run) throw new Error("queued run not found");
    return new PersistedRunEventSink(runs, command, liveEvents, liveEventFailureReporter, run.events.length, deferTerminal);
  }

  async append(event: NewRunEvent): Promise<RunEvent> {
    if (this.deferTerminal && (event.type === "completed" || event.type === "abstained")) {
      if (this.deferredTerminal) throw new Error("research run emitted more than one terminal event");
      this.deferredTerminal = event;
      await this.pending;
      return RunEventSchema.parse({ ...event, id: randomUUID(), sequence: this.sequence + 1 });
    }
    const operation = this.pending.then(async () => {
      const stored = RunEventSchema.parse({ ...event, id: randomUUID(), sequence: ++this.sequence });
      await this.runs.appendEvent(this.command.scope, stored);
      try { await this.liveEvents?.publish(stored); }
      catch (error) {
        // Live delivery is deliberately non-authoritative. The persisted event
        // is available for replay even while Redis is impaired.
        this.liveEventFailureReporter.report(stored, error);
      }
      return stored;
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async takeDeferredTerminal(): Promise<Extract<RunEvent, { type: "completed" | "abstained" }>> {
    await this.pending;
    if (!this.deferredTerminal) throw new Error("research runtime did not emit a terminal event");
    return RunEventSchema.parse({ ...this.deferredTerminal, id: randomUUID(), sequence: this.sequence + 1 }) as Extract<RunEvent, { type: "completed" | "abstained" }>;
  }

  async commitDeferredTerminal(event: Extract<RunEvent, { type: "completed" | "abstained" }>): Promise<void> {
    if (!this.deferredTerminal || event.sequence !== this.sequence + 1) throw new Error("invalid deferred terminal event");
    this.sequence = event.sequence;
    try { await this.liveEvents?.publish(event); }
    catch (error) { this.liveEventFailureReporter.report(event, error); }
  }
}
