import type { ResearchScope, RunEvent, StoredRun as ContractStoredRun } from "@research/contracts";

export type StoredRun = ContractStoredRun;
export type RunControlResult = "paused" | "resumed" | "not_found" | "not_allowed" | "command_missing";
export interface RunStore {
  create(run: Omit<StoredRun, "events" | "status" | "answer">): Promise<void>;
  /** Atomically claims a queued run so duplicate queue deliveries cannot execute it twice. */
  claim(scope: ResearchScope, runId: string): Promise<boolean>;
  /** Allows exactly one safe recovery transition from failed back to queued. */
  requeueForRecovery(scope: ResearchScope, runId: string): Promise<boolean>;
  /** Atomically fails a running record whose execution lease has elapsed. */
  expireStaleLease(scope: ResearchScope, runId: string): Promise<boolean>;
  /** Pauses a queued command before a Worker can begin model or tool work. */
  pause(scope: ResearchScope, runId: string, event: Extract<RunEvent, { type: "run_paused" }>): Promise<RunControlResult>;
  /** Requeues the original immutable command and emits an auditable resume event. */
  resume(scope: ResearchScope, runId: string, event: Extract<RunEvent, { type: "run_resumed" }>): Promise<RunControlResult>;
  appendEvent(scope: ResearchScope, event: RunEvent): Promise<void>;
  finish(scope: ResearchScope, runId: string, status: StoredRun["status"], answer?: string): Promise<void>;
  get(scope: ResearchScope, id: string): Promise<StoredRun | undefined>;
}
export interface SqlClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}
