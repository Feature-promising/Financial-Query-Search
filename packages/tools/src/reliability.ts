import type { ToolFailure } from "@research/contracts";

export interface ToolReliabilityPolicy {
  maxAttempts: number;
  retryDelayMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
}

export const defaultToolReliabilityPolicy: ToolReliabilityPolicy = {
  maxAttempts: 2,
  retryDelayMs: 50,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 30_000,
};

/** Per-process circuit state. Durable audit remains the authority for review. */
export class ToolCircuitBreaker {
  private readonly states = new Map<string, { failures: number; openUntil: number }>();

  isOpen(toolId: string, now = Date.now()): boolean {
    return (this.states.get(toolId)?.openUntil ?? 0) > now;
  }

  recordSuccess(toolId: string): void { this.states.delete(toolId); }

  recordFailure(toolId: string, policy: ToolReliabilityPolicy, now = Date.now()): void {
    const state = this.states.get(toolId) ?? { failures: 0, openUntil: 0 };
    state.failures += 1;
    if (state.failures >= policy.circuitFailureThreshold) state.openUntil = now + policy.circuitCooldownMs;
    this.states.set(toolId, state);
  }
}

export function isTransientFailure(failure: ToolFailure): boolean {
  // The tool owns whether a provider failure is safe to retry.  For example,
  // an unavailable source may require a Critic-directed supplementary task
  // rather than immediately replaying the same request.
  return failure.retryable;
}

export function retryDelay(attempt: number, policy: ToolReliabilityPolicy): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, policy.retryDelayMs * attempt));
}
