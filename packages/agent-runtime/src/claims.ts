import type { Claim, EvidenceItem } from "@research/contracts";
import type { ClaimComposer, ResearchState } from "./types.js";

/**
 * Fail-closed implementation until a structured Bedrock claim composer and
 * semantic-entailment evaluator are configured. It never invents a claim.
 */
export class SafeClaimComposer implements ClaimComposer {
  async compose(_evidence: EvidenceItem[], _state: Pick<ResearchState, "intent" | "conversation" | "run">): Promise<Claim[]> {
    return [];
  }
}
