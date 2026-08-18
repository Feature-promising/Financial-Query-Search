import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assessNumericConsistency, evaluateCase, type EvaluationCase } from "../src/index.js";

describe("evaluation numeric consistency", () => {
  it("scores numeric claims against their cited evidence and exposes the metric on a case result", () => {
    const evidenceId = randomUUID();
    const claim = { id: randomUUID(), text: "Revenue was $10 million.", evidenceIds: [evidenceId], confidence: 0.9, qualification: null };
    const evidence = [{ id: evidenceId, content: "Revenue was $9 million." } as never];
    const testCase: EvaluationCase = { id: "numeric", category: "company_fact", question: "Q", expectedAbstention: false, expectedEvidenceIds: [evidenceId] };

    expect(assessNumericConsistency([claim], evidence)).toBe(0);
    expect(evaluateCase(testCase, "completed", [claim], evidence)).toMatchObject({ numericConsistency: 0 });
  });
});
