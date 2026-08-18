import type {
  Claim,
  EvidenceItem,
  Intent,
  ResearchPlan,
  ResearchRun,
  ResearchMemoryHint,
  ResearchMemoryPublication,
  ResearchScope,
  ResearchTask,
  RunCostLedger,
  RunBudget,
  RunEvent,
  NewRunEvent,
} from "@research/contracts";
import type { PrioritizedMemoryContext } from "@research/memory";
import type { ResearchReportDocument } from "@research/reports";

export interface ConversationContext {
  conversationId: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Ordered layers; no layer is silently promoted to the user question. */
  memories: PrioritizedMemoryContext;
}

export interface CriticResult {
  publishable: boolean;
  reason: string;
  rejectedClaimIds: string[];
}

export interface ResearchState {
  run: ResearchRun;
  conversation: ConversationContext;
  intent?: Intent;
  plan?: ResearchPlan;
  tasks: ResearchTask[];
  evidence: EvidenceItem[];
  claims: Claim[];
  budget: RunBudget;
  criticRepairs: number;
  criticResult?: CriticResult;
}

export interface ResearchRunInput {
  runId: string;
  conversationId: string;
  question: string;
  scope: ResearchScope;
  budget: RunBudget;
  /** Immutable API-authorized agent tool configuration for this queued run. */
  toolManifestSnapshot?: import("@research/contracts").ToolManifest[];
  recentMessages?: ConversationContext["recentMessages"];
  /** Worker-drain signal; unlike the immutable deadline, it is not user input. */
  shutdownSignal?: AbortSignal;
}

export interface ResearchRunResult {
  state: ResearchState;
  answer: string;
  status: "completed" | "abstained";
  /** Present only after the controlled report renderer passes citation checks. */
  report?: ResearchReportDocument;
  /** Durable only when the caller's report finalization commits it. */
  researchMemory?: ResearchMemoryPublication;
}

/**
 * One in-process, bounded execution of a run. It is intentionally separate
 * from the persisted checkpoint: live budget accounting is not a recovery
 * payload after a billed tool phase.
 */
export interface ResearchRuntimeSession {
  input: ResearchRunInput;
  state: ResearchState;
  usage: {
    deadline: number;
    toolCalls: number;
    /** Copied from the immutable input; used only at the tool boundary. */
    toolManifestSnapshot?: import("@research/contracts").ToolManifest[];
    abortController: AbortController;
    deadlineTimer: ReturnType<typeof setTimeout>;
    detachShutdownSignal?: () => void;
  };
  costLedger: RunCostLedger;
}

export interface RunEventSink {
  append(event: NewRunEvent): Promise<RunEvent>;
}

export type ResearchPhase = "context_loaded" | "intent_analyzed" | "planned" | "tasks_executed" | "evidence_built" | "claims_composed" | "critic_completed" | "published";

/** Append-only runtime checkpoint. Evidence is referenced by ID, never duplicated into a checkpoint. */
export interface RunCheckpoint {
  runId: string;
  organizationId: string;
  phase: ResearchPhase;
  snapshot: {
    intent?: Intent;
    plan?: ResearchPlan;
    tasks: ResearchTask[];
    evidenceIds: string[];
    claims: Claim[];
    criticRepairs?: number;
    criticResult?: CriticResult;
  };
  createdAt: string;
}

export interface RunCheckpointSink {
  save(checkpoint: RunCheckpoint): Promise<void>;
}

export interface IntentAnalyzer {
  analyze(question: string, signal?: AbortSignal): Promise<Intent>;
}

/**
 * Non-evidentiary context for planning only. The active question remains the
 * authority; preferences may influence presentation or method defaults, never
 * facts, citations, or a user-specified time range.
 */
export interface ResearchPlanningContext {
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  userPreferences: Array<Pick<import("@research/contracts").MemoryRecord, "content" | "metadata">>;
  /** Submission-time tool IDs only; provider output is never planner context. */
  availableToolIds?: string[];
  /** Historical report metadata only; it is a retrieval lead, not evidence. */
  researchMemoryHints?: ResearchMemoryHint[];
}

export interface Planner {
  plan(intent: Intent, question: string, budget: RunBudget, signal?: AbortSignal, context?: ResearchPlanningContext): Promise<ResearchPlan>;
}

export interface ClaimComposer {
  compose(evidence: EvidenceItem[], state: Pick<ResearchState, "intent" | "conversation" | "run">, signal?: AbortSignal): Promise<Claim[]>;
}

/** Independent semantic check over already authorized, cited evidence. */
export interface ClaimEntailmentVerifier {
  verify(claims: Claim[], evidence: EvidenceItem[], scope: ResearchScope, signal?: AbortSignal): Promise<Array<{ claimId: string; supported: boolean; reason?: string }>>;
}
