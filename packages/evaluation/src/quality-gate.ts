import type { EvaluationResult } from "./index.js";

export interface QualityThresholds {
  minCitationPrecision: number;
  minCitationRecall: number;
  minAbstentionAccuracy: number;
  minNumericConsistency: number;
}

export interface QualityGateResult {
  passed: boolean;
  citationPrecision: number;
  citationRecall: number;
  abstentionAccuracy: number;
  numericConsistency: number;
  failures: string[];
}

/** Deterministic release gate over a versioned golden evaluation set. */
export function assessQualityGate(results: EvaluationResult[], thresholds: QualityThresholds): QualityGateResult {
  if (!results.length) return { passed: false, citationPrecision: 0, citationRecall: 0, abstentionAccuracy: 0, numericConsistency: 0, failures: ["evaluation set is empty"] };
  const citationPrecision = average(results.map((result) => result.citationPrecision));
  const citationRecall = average(results.map((result) => result.citationRecall));
  const abstentionAccuracy = average(results.map((result) => result.abstentionCorrect ? 1 : 0));
  const numericConsistency = average(results.map((result) => result.numericConsistency));
  const failures = [
    citationPrecision < thresholds.minCitationPrecision ? `citation precision ${citationPrecision.toFixed(3)} below threshold` : undefined,
    citationRecall < thresholds.minCitationRecall ? `citation recall ${citationRecall.toFixed(3)} below threshold` : undefined,
    abstentionAccuracy < thresholds.minAbstentionAccuracy ? `abstention accuracy ${abstentionAccuracy.toFixed(3)} below threshold` : undefined,
    numericConsistency < thresholds.minNumericConsistency ? `numeric consistency ${numericConsistency.toFixed(3)} below threshold` : undefined,
  ].filter((failure): failure is string => Boolean(failure));
  return { passed: failures.length === 0, citationPrecision, citationRecall, abstentionAccuracy, numericConsistency, failures };
}

function average(values: number[]): number { return values.reduce((total, value) => total + value, 0) / values.length; }
