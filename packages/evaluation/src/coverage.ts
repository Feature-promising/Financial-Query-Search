import type { EvaluationCase, EvaluationCategory } from "./index.js";

export const REQUIRED_EVALUATION_CATEGORIES: readonly EvaluationCategory[] = [
  "company_fact",
  "earnings_analysis",
  "competitive_comparison",
  "valuation_sensitivity",
  "period_conflict",
  "financial_data_conflict",
  "missing_evidence",
  "authorization_boundary",
  "prompt_injection",
  "task_coverage",
] as const;

export interface EvaluationCoverage {
  complete: boolean;
  missing: EvaluationCategory[];
  duplicated: EvaluationCategory[];
  unexpected: string[];
}

/** Ensures a release dataset covers each promised financial safety category exactly once. */
export function assessEvaluationCoverage(cases: readonly EvaluationCase[]): EvaluationCoverage {
  const counts = new Map<string, number>();
  for (const item of cases) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  const required = new Set<string>(REQUIRED_EVALUATION_CATEGORIES);
  const missing = REQUIRED_EVALUATION_CATEGORIES.filter((category) => !counts.has(category));
  const duplicated = REQUIRED_EVALUATION_CATEGORIES.filter((category) => (counts.get(category) ?? 0) > 1);
  const unexpected = [...counts.keys()].filter((category) => !required.has(category));
  return { complete: missing.length === 0 && duplicated.length === 0 && unexpected.length === 0, missing, duplicated, unexpected };
}
