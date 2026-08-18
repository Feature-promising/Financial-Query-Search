import { verifyNumericConsistency } from "@research/knowledge";
import type { Claim, EvidenceItem } from "@research/contracts";

/**
 * Scores only claims that assert a material numeric value. Claims without a
 * number are outside this deterministic guard; their entailment remains the
 * responsibility of the citation verifier.
 */
export function assessNumericConsistency(claims: Claim[], evidence: EvidenceItem[]): number {
  const numericClaims = claims.filter((claim) => hasMaterialNumber(claim.text));
  if (!numericClaims.length) return 1;
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const valid = numericClaims.filter((claim) => verifyNumericConsistency(claim, evidenceById).valid).length;
  return valid / numericClaims.length;
}

function hasMaterialNumber(text: string): boolean {
  return /(?:\$?\d[\d,.]*\s?(?:%|bps|million|billion|[MBK])?)/i.test(text);
}
