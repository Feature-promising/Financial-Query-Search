import type { z } from "zod";
import type { EvidenceItem, ResearchScope, RunCostLedger, ToolFailure, ToolManifest } from "@research/contracts";

export interface ToolContext {
  runId: string;
  scope: ResearchScope;
  /** Immutable API-approved tool allowlist for a queued research run. */
  toolManifestSnapshot?: ToolManifest[];
  remainingToolCalls: number;
  /** Deterministic per-run/task key; the registry derives one for legacy callers. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Shared per-run ledger; the registry reserves before billable provider work. */
  costLedger?: RunCostLedger;
}

export type ToolResult<T> =
  | { ok: true; value: T; evidence: EvidenceItem[]; estimatedCostUsd: number }
  | { ok: false; failure: ToolFailure; estimatedCostUsd: number };

export interface Tool<I, O> {
  manifest: ToolManifest;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  invoke(input: I, context: ToolContext): Promise<ToolResult<O>>;
}

export interface ToolInvocationAudit {
  runId: string;
  organizationId: string;
  toolId: string;
  idempotencyKey: string;
  at: string;
  ok: boolean;
  inputHash: string;
  outputHash?: string;
  evidenceIds: string[];
  estimatedCostUsd: number;
  durationMs: number;
  failureCode?: ToolFailure["code"];
}

export interface ToolAuditSink { write(event: ToolInvocationAudit): Promise<void>; }

export class InMemoryToolAuditSink implements ToolAuditSink {
  readonly events: ToolInvocationAudit[] = [];
  async write(event: ToolInvocationAudit): Promise<void> { this.events.push(event); }
}
