import { describe, expect, it } from "vitest";
import { assessEvaluationCoverage, assessQualityGate } from "../../src/index.js";
import { executeGoldenFixture } from "./executor.js";
import { GOLDEN_FIXTURES } from "./fixtures.js";

describe("golden release gate", () => {
  it("requires cited answers and correct abstention across financial safety scenarios", async () => {
    const results = await Promise.all(GOLDEN_FIXTURES.map(executeGoldenFixture));
    const coverage = assessEvaluationCoverage(GOLDEN_FIXTURES.map((fixture) => fixture.evaluation));
    const gate = assessQualityGate(results, { minCitationPrecision: 1, minCitationRecall: 1, minAbstentionAccuracy: 1, minNumericConsistency: 1 });
    expect(results).toHaveLength(10);
    expect(coverage).toEqual({ complete: true, missing: [], duplicated: [], unexpected: [] });
    expect(results.every((result) => result.abstentionCorrect)).toBe(true);
    expect(gate).toMatchObject({ passed: true, citationPrecision: 1, citationRecall: 1, abstentionAccuracy: 1, numericConsistency: 1 });
  });
});
