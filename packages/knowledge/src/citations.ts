import { isClaimEvidenceEligible, isEvidenceAuthorized, type Claim, type EvidenceItem, type ResearchScope } from "@research/contracts";
import type { CitationVerification } from "./types.js";

/** Server-side structural citation gate. Semantic entailment is supplied by a separately versioned evaluator. */
export function verifyCitations(claims: Claim[], evidence: EvidenceItem[], scope: ResearchScope, requestedPeriod?: string | null): CitationVerification[] {
  const visible = new Map(evidence.filter((item) => isClaimEvidenceEligible(item) && isEvidenceAuthorized(scope, item)).map((item) => [item.id, item]));
  return claims.map((claim) => {
    const missing = claim.evidenceIds.find((id) => !visible.has(id));
    if (missing) return { claimId: claim.id, valid: false, reason: `missing or unauthorized evidence: ${missing}` };
    const cited = claim.evidenceIds.map((id) => visible.get(id)!);
    if (cited.some((item) => item.authority === "secondary") && !scope.entitlements.includes("secondary-research")) return { claimId: claim.id, valid: false, reason: "secondary evidence is not entitled for this user" };
    if (cited.every((item) => item.authority === "secondary")) return { claimId: claim.id, valid: false, reason: "secondary evidence cannot solely support a financial claim" };
    if (requestedPeriod && cited.some((item) => !matchesPeriod(item, requestedPeriod))) return { claimId: claim.id, valid: false, reason: `evidence does not match requested period: ${requestedPeriod}` };
    return { claimId: claim.id, valid: true };
  });
}

/** A cited fact must be explicitly tagged with a compatible as-of or publication date. */
function matchesPeriod(item: EvidenceItem, requestedPeriod: string): boolean {
  const metadataPeriods = [item.metadata.fiscalPeriod, item.metadata.reportingPeriod, item.metadata.sourceAsOf]
    .filter((value): value is string => typeof value === "string");
  const dates = [item.asOfDate, item.publishedAt, ...metadataPeriods].filter((value): value is string => value !== null);
  if (!dates.length) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(requestedPeriod)) return dates.some((date) => date.startsWith(requestedPeriod));
  // Financial warehouse rows often encode a fiscal year as FY2025 while SEC
  // records use a calendar report date. Both are explicit source metadata.
  return dates.some((date) => date.startsWith(requestedPeriod) || date === `FY${requestedPeriod}`);
}
