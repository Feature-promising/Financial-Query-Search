import { describe, expect, it } from "vitest";
import { assessQualityGate } from "../src/index.js";

describe("assessQualityGate", () => {
  it("fails a release when citation precision is below the configured floor", () => {
    const result = assessQualityGate([{ caseId: "c-1", category: "company_fact", abstentionCorrect: true, citationPrecision: 0.8, citationRecall: 1, numericConsistency: 1 }], { minCitationPrecision: 0.9, minCitationRecall: 0.9, minAbstentionAccuracy: 1, minNumericConsistency: 1 });
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("citation precision");
  });

  it("fails a release when cited numeric claims do not match their source", () => {
    const result = assessQualityGate([{ caseId: "c-1", category: "company_fact", abstentionCorrect: true, citationPrecision: 1, citationRecall: 1, numericConsistency: 0 }], { minCitationPrecision: 1, minCitationRecall: 1, minAbstentionAccuracy: 1, minNumericConsistency: 1 });
    expect(result).toMatchObject({ passed: false, numericConsistency: 0 });
    expect(result.failures).toContain("numeric consistency 0.000 below threshold");
  });
});
