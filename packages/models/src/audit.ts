import { AsyncLocalStorage } from "node:async_hooks";
import type { RunCostLedger } from "@research/contracts";

export interface ModelInvocationContext {
  runId: string;
  organizationId: string;
  costLedger?: RunCostLedger;
}

export interface ModelInvocationAudit {
  runId: string;
  organizationId: string;
  modelId: string;
  operation: string;
  invokedAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

export interface ModelAuditSink {
  write(event: ModelInvocationAudit): Promise<void>;
}

const invocationContext = new AsyncLocalStorage<ModelInvocationContext>();

/** Binds model accounting to a single run without mutable global request state. */
export function withModelInvocationContext<T>(context: ModelInvocationContext, operation: () => Promise<T>): Promise<T> {
  return invocationContext.run(context, operation);
}

export function currentModelInvocationContext(): ModelInvocationContext | undefined {
  return invocationContext.getStore();
}

export function estimateModelCost(inputTokens: number, outputTokens: number, inputCostPer1kUsd?: number, outputCostPer1kUsd?: number): number | null {
  if (inputCostPer1kUsd == null || outputCostPer1kUsd == null) return null;
  return (inputTokens / 1_000) * inputCostPer1kUsd + (outputTokens / 1_000) * outputCostPer1kUsd;
}
