import { RunEventSchema } from "@research/contracts";
import type { ResearchEvent } from "./research-types";

/** Converts only a validated API event into the UI's intentionally simple projection. */
export function parseResearchEvent(value: unknown): ResearchEvent | undefined {
  const parsed = RunEventSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    type: parsed.data.type,
    payload: parsed.data.payload as Record<string, unknown>,
    runId: parsed.data.runId,
    sequence: parsed.data.sequence,
  };
}
