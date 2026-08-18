import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyNumericConsistency } from "../src/index.js";

describe("verifyNumericConsistency", () => {
  it("rejects a cited claim whose material number is absent from evidence", () => {
    const evidenceId = randomUUID();
    const result = verifyNumericConsistency({ id: randomUUID(), text: "Revenue was $10 billion.", evidenceIds: [evidenceId], confidence: 0.8, qualification: null }, new Map([[evidenceId, { content: "Revenue was $9 billion." } as never]]));
    expect(result.valid).toBe(false);
  });
});
