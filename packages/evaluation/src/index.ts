import type { Claim, EvidenceItem } from "@research/contracts";
import { assessNumericConsistency } from "./numeric-consistency.js";

export type EvaluationCategory = "company_fact" | "earnings_analysis" | "competitive_comparison" | "valuation_sensitivity" | "period_conflict" | "financial_data_conflict" | "missing_evidence" | "authorization_boundary" | "prompt_injection" | "task_coverage";

export interface EvaluationCase {
  id: string;
  category: EvaluationCategory;
  question: string;
  expectedAbstention: boolean;
  expectedEvidenceIds: string[];
}

export interface EvaluationResult {
  caseId: string;
  category: EvaluationCategory;
  abstentionCorrect: boolean;
  citationRecall: number;
  citationPrecision: number;
  /** Share of numeric claims whose cited source contains the asserted value. */
  numericConsistency: number;
}

export function evaluateCase(testCase: EvaluationCase, status: "completed" | "abstained", claims: Claim[], evidence: EvidenceItem[]): EvaluationResult {
  const used = new Set(claims.flatMap((claim) => claim.evidenceIds));
  const expected = new Set(testCase.expectedEvidenceIds);
  const valid = new Set(evidence.map((item) => item.id));
  const expectedHits = [...expected].filter((id) => used.has(id)).length;
  const supportedUsed = [...used].filter((id) => valid.has(id)).length;
  return {
    caseId: testCase.id,
    category: testCase.category,
    abstentionCorrect: testCase.expectedAbstention === (status === "abstained"),
    citationRecall: expected.size === 0 ? 1 : expectedHits / expected.size,
    citationPrecision: used.size === 0 ? 1 : supportedUsed / used.size,
    numericConsistency: assessNumericConsistency(claims, evidence),
  };
}

export * from "./quality-gate.js";
export * from "./coverage.js";
export * from "./numeric-consistency.js";
