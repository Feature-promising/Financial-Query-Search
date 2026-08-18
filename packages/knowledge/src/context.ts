import { EvidenceItemSchema, isClaimEvidenceEligible, isEvidenceAuthorized, type EvidenceItem, type ResearchScope } from "@research/contracts";
import { annotateEvidenceSafety, isHighRiskEvidence } from "./security/prompt-injection.js";
import { redactEvidenceForModel } from "./security/sensitive-data.js";

export interface ContextChunk {
  evidenceId: string;
  content: string;
  locator: string;
  authority: EvidenceItem["authority"];
  asOfDate: string | null;
}

/** Filters evidence for an authorized retrieval result without modifying source text. */
export function filterAuthorizedEvidence(scope: ResearchScope, candidates: EvidenceItem[], tokenBudget = 8_000): EvidenceItem[] {
  let remaining = tokenBudget;
  // Vector indexes and tool providers are external boundaries. Re-parse every
  // candidate here, before its content reaches injection detection or a model.
  return candidates.flatMap((candidate) => {
    const parsed = EvidenceItemSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  }).filter(isClaimEvidenceEligible).map(annotateEvidenceSafety)
    .filter((item) => isEvidenceAuthorized(scope, item))
    .filter((item) => !isHighRiskEvidence(item))
    .filter((item) => item.authority !== "secondary" || scope.entitlements.includes("secondary-research"))
    .sort((left, right) => authorityRank(left.authority) - authorityRank(right.authority))
    .filter((item) => {
      const estimatedTokens = Math.ceil(item.content.length / 4);
      if (estimatedTokens > remaining) return false;
      remaining -= estimatedTokens;
      return true;
    });
}

/** Applies authorization, injection filtering, and sensitive-data redaction before source text reaches a model. */
export function buildContext(scope: ResearchScope, candidates: EvidenceItem[], tokenBudget = 8_000): EvidenceItem[] {
  return filterAuthorizedEvidence(scope, candidates, tokenBudget).map(redactEvidenceForModel);
}

export function toContextChunks(items: EvidenceItem[]): ContextChunk[] {
  return items.map((item) => ({ evidenceId: item.id, content: item.content, locator: item.locator, authority: item.authority, asOfDate: item.asOfDate }));
}

function authorityRank(authority: EvidenceItem["authority"]): number { return authority === "primary" ? 0 : authority === "licensed" ? 1 : 2; }
