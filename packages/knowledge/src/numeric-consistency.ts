import type { Claim, EvidenceItem } from "@research/contracts";

/** Conservative deterministic guard: every material number in a claim must occur in cited source text. */
export function verifyNumericConsistency(claim: Claim, evidenceById: ReadonlyMap<string, EvidenceItem>): { valid: boolean; reason?: string } {
  const source = claim.evidenceIds.map((id) => evidenceById.get(id)?.content ?? "").join("\n");
  const numbers = claim.text.match(/(?:\$?\d[\d,.]*\s?(?:%|bps|million|billion|[MBK])?)/gi) ?? [];
  const missing = numbers.find((number) => !source.includes(number));
  return missing ? { valid: false, reason: `numeric claim is not present in cited evidence: ${missing}` } : { valid: true };
}
