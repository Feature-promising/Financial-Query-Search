import { describe, expect, it } from "vitest";
import { assessEvaluationCoverage, type EvaluationCase } from "../src/index.js";

describe("assessEvaluationCoverage", () => {
  it("rejects a release set with a duplicated category and a missing category", () => {
    const cases: EvaluationCase[] = [
      { id: "fact-1", category: "company_fact", question: "Q", expectedAbstention: false, expectedEvidenceIds: [] },
      { id: "fact-2", category: "company_fact", question: "Q", expectedAbstention: false, expectedEvidenceIds: [] },
    ];

    const coverage = assessEvaluationCoverage(cases);
    expect(coverage.complete).toBe(false);
    expect(coverage.duplicated).toEqual(["company_fact"]);
    expect(coverage.missing).toContain("prompt_injection");
  });
});
