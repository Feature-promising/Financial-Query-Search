import { canAccessOwnedResource, RunEventSchema, StoredRunSchema, type ResearchScope, type RunEvent } from "@research/contracts";
import type { RunStore, StoredRun } from "./types.js";

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, StoredRun>();
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly leases = new Map<string, number>();

  constructor(private readonly options: { leaseDurationMs?: number; now?: () => number } = {}) {}

  async create(run: Omit<StoredRun, "events" | "status" | "answer">): Promise<void> {
    const stored = StoredRunSchema.parse({ ...run, status: "queued", events: [] });
    this.runs.set(stored.id, stored);
  }
  async claim(scope: ResearchScope, runId: string): Promise<boolean> {
    const run = this.require(scope, runId);
    if (run.status !== "queued") return false;
    run.status = "running";
    this.leases.set(runId, this.now() + (this.options.leaseDurationMs ?? 360_000));
    return true;
  }
  async requeueForRecovery(scope: ResearchScope, runId: string): Promise<boolean> {
    const run = this.require(scope, runId);
    if (run.status !== "failed" || (this.recoveryAttempts.get(runId) ?? 0) >= 1) return false;
    this.recoveryAttempts.set(runId, 1); run.status = "queued"; return true;
  }
  async expireStaleLease(scope: ResearchScope, runId: string): Promise<boolean> {
    const run = this.require(scope, runId);
    const expiresAt = this.leases.get(runId);
    if (run.status !== "running" || expiresAt == null || expiresAt > this.now()) return false;
    run.status = "failed";
    this.leases.delete(runId);
    return true;
  }
  async pause(scope: ResearchScope, runId: string, event: Extract<RunEvent, { type: "run_paused" }>): Promise<import("./types.js").RunControlResult> {
    const run = this.runs.get(runId);
    if (!run || !canAccessOwnedResource(scope, run.organizationId, run.createdBy)) return "not_found";
    if (run.status !== "queued") return "not_allowed";
    const stored = RunEventSchema.parse(event);
    if (stored.runId !== runId || stored.sequence !== run.events.length + 1) throw new Error("invalid pause event sequence");
    run.status = "paused";
    run.events.push(stored);
    return "paused";
  }
  async resume(scope: ResearchScope, runId: string, event: Extract<RunEvent, { type: "run_resumed" }>): Promise<import("./types.js").RunControlResult> {
    const run = this.runs.get(runId);
    if (!run || !canAccessOwnedResource(scope, run.organizationId, run.createdBy)) return "not_found";
    if (run.status !== "paused") return "not_allowed";
    const stored = RunEventSchema.parse(event);
    if (stored.runId !== runId || stored.sequence !== run.events.length + 1) throw new Error("invalid resume event sequence");
    run.status = "queued";
    run.events.push(stored);
    return "resumed";
  }
  async appendEvent(scope: ResearchScope, event: RunEvent): Promise<void> {
    const validated = RunEventSchema.parse(event);
    const run = this.require(scope, validated.runId);
    run.events.push(validated);
    run.status = validated.type === "run_started" ? "running" : run.status;
  }
  async finish(scope: ResearchScope, runId: string, status: StoredRun["status"], answer?: string): Promise<void> {
    const run = this.require(scope, runId);
    if (run.status !== "running") throw new Error("run is no longer active");
    const updated = StoredRunSchema.parse({ ...run, status, ...(answer === undefined ? {} : { answer }) });
    this.runs.set(runId, updated);
    this.leases.delete(runId);
  }
  async get(scope: ResearchScope, id: string): Promise<StoredRun | undefined> { const run = this.runs.get(id); return run && canAccessOwnedResource(scope, run.organizationId, run.createdBy) ? { ...run, events: [...run.events] } : undefined; }
  private require(scope: ResearchScope, id: string): StoredRun { const run = this.runs.get(id); if (!run || !canAccessOwnedResource(scope, run.organizationId, run.createdBy)) throw new Error("run not found"); return run; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
}
