import type { RunCheckpoint } from "./types.js";

export interface RecoveryDecision { automatic: boolean; reason: string; }

const researchPhases = ["context_loaded", "intent_analyzed", "planned", "tasks_executed", "evidence_built", "claims_composed", "critic_completed", "published"] as const;
export type RecoveryCheckpointPhase = typeof researchPhases[number];
const automaticallyRecoverablePhases = ["context_loaded", "intent_analyzed", "planned"] as const;
export type AutomaticallyRecoverablePhase = typeof automaticallyRecoverablePhases[number];

/** Rejects malformed durable checkpoint data rather than attempting a replay. */
export function isRecoveryCheckpointPhase(value: string): value is RecoveryCheckpointPhase {
  return (researchPhases as readonly string[]).includes(value);
}

export function isAutomaticallyRecoverablePhase(value: RecoveryCheckpointPhase): value is AutomaticallyRecoverablePhase {
  return (automaticallyRecoverablePhases as readonly string[]).includes(value);
}

/**
 * Conservative recovery policy: a run may only be automatically replayed
 * before any task could have invoked a side-effecting or billed tool.
 */
export function decideRecovery(checkpoint: RunCheckpoint | undefined): RecoveryDecision {
  if (!checkpoint) return { automatic: false, reason: "no checkpoint is available" };
  if (isRecoveryCheckpointPhase(checkpoint.phase) && isAutomaticallyRecoverablePhase(checkpoint.phase)) return { automatic: true, reason: "no task execution checkpoint exists" };
  return { automatic: false, reason: "task execution may already have invoked a billed tool; require audited replay" };
}
