import type { ResearchScope } from "@research/contracts";
import type { RunStore } from "./types.js";

/**
 * Attempts the terminal failure transition without overwriting an already
 * terminal result. Callers use this after a best-effort failure-event write:
 * event storage being unavailable must not strand a run in `running`.
 */
export async function markRunFailedIfActive(
  runs: RunStore,
  scope: ResearchScope,
  runId: string,
  answer = "Research execution failed before a publishable result was delivered.",
): Promise<boolean> {
  const run = await runs.get(scope, runId);
  if (!run || run.status !== "running") return false;
  await runs.finish(scope, runId, "failed", answer);
  return true;
}
