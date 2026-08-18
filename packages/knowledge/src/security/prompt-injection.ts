import type { EvidenceItem } from "@research/contracts";

export interface PromptInjectionAssessment {
  detected: boolean;
  severity: "none" | "low" | "high";
  matches: string[];
}

const HIGH_RISK_PATTERNS = [
  /ignore (?:all |any |the )?(?:previous|prior|system) instructions?/i,
  /(?:reveal|print|show|exfiltrate) (?:the )?(?:system prompt|secret|credentials?)/i,
  /you are now (?:a|an) .*?(?:assistant|system)/i,
  /follow these instructions instead/i,
];
const LOW_RISK_PATTERNS = [/system message/i, /developer message/i, /do not trust (?:the )?user/i];

/** Rule-based first gate. A versioned classifier can be layered on this interface later. */
export function assessPromptInjection(content: string): PromptInjectionAssessment {
  const high = HIGH_RISK_PATTERNS.filter((pattern) => pattern.test(content)).map((pattern) => pattern.source);
  if (high.length) return { detected: true, severity: "high", matches: high };
  const low = LOW_RISK_PATTERNS.filter((pattern) => pattern.test(content)).map((pattern) => pattern.source);
  return low.length ? { detected: true, severity: "low", matches: low } : { detected: false, severity: "none", matches: [] };
}

/** Preserves the original evidence while appending machine-auditable safety metadata. */
export function annotateEvidenceSafety(item: EvidenceItem): EvidenceItem {
  const assessment = assessPromptInjection(item.content);
  return { ...item, metadata: { ...item.metadata, promptInjection: assessment } };
}

export function isHighRiskEvidence(item: EvidenceItem): boolean {
  const assessment = item.metadata.promptInjection;
  return typeof assessment === "object" && assessment !== null && "severity" in assessment && (assessment as { severity?: unknown }).severity === "high";
}
