import { isClaimEvidenceEligible, type EvidenceItem } from "@research/contracts";
import { findFinancialEvidenceConflicts, verifyCitations, verifyNumericConsistency } from "@research/knowledge";
import { annotateEvidenceSafety, isHighRiskEvidence } from "@research/knowledge";
import type { CriticResult, ResearchState } from "./types.js";

export function normalizeEvidence(items: EvidenceItem[], tenantId: string): EvidenceItem[] {
  const unique = new Map<string, EvidenceItem>();
  for (const item of items) {
    const annotated = annotateEvidenceSafety(item);
    if (annotated.tenantId === tenantId && isClaimEvidenceEligible(annotated) && annotated.content.trim() && !isHighRiskEvidence(annotated)) unique.set(annotated.contentHash, annotated);
  }
  return [...unique.values()].sort((left, right) => authorityRank(left.authority) - authorityRank(right.authority));
}

export function critic(state: ResearchState): CriticResult {
  if (state.evidence.length === 0) return { publishable: false, reason: "No verified, permissioned evidence was returned by configured tools.", rejectedClaimIds: [] };
  const completedRepairs = new Set(state.tasks
    .filter((task) => task.status === "completed")
    .flatMap((task) => repairTarget(task.id)));
  const incompleteTasks = state.tasks.filter((task) => (task.status === "failed" || task.status === "skipped") && !completedRepairs.has(task.id));
  if (incompleteTasks.length) {
    return {
      publishable: false,
      reason: `Research plan coverage is incomplete: ${incompleteTasks.map((task) => task.id).join(", ")}.`,
      rejectedClaimIds: [],
    };
  }
  const evidenceById = new Map(state.evidence.map((item) => [item.id, item]));
  const citationRejected = verifyCitations(state.claims, state.evidence, state.run.scope, state.intent?.period).filter((result) => !result.valid).map((result) => result.claimId);
  const numberRejected = state.claims.filter((claim) => !verifyNumericConsistency(claim, evidenceById).valid).map((claim) => claim.id);
  const conflictingEvidenceIds = new Set(findFinancialEvidenceConflicts(state.evidence).flatMap((conflict) => conflict.evidenceIds));
  const conflictRejected = state.claims.filter((claim) => claim.evidenceIds.some((id) => conflictingEvidenceIds.has(id))).map((claim) => claim.id);
  const rejected = [...new Set([...citationRejected, ...numberRejected, ...conflictRejected])];
  if (state.claims.length === 0) return { publishable: false, reason: "No claims passed server-side citation binding.", rejectedClaimIds: rejected };
  return {
    publishable: rejected.length === 0,
    reason: rejected.length
      ? conflictRejected.length ? "One or more claims rely on unresolved canonical financial-data conflicts." : "One or more claims reference invalid evidence."
      : "All claims have valid evidence identifiers.",
    rejectedClaimIds: rejected,
  };
}

/** A successful bounded repair covers its original task without erasing the failed audit record. */
function repairTarget(taskId: string): string[] {
  const match = /^critic-repair-\d+-(.+)$/.exec(taskId);
  return match?.[1] ? [match[1]] : [];
}

function authorityRank(authority: EvidenceItem["authority"]): number {
  return authority === "primary" ? 0 : authority === "licensed" ? 1 : 2;
}
