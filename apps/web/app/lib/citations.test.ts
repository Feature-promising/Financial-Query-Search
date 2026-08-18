import { describe, expect, it } from "vitest";
import { evidenceIdForCitation, terminalAnswer } from "./citations";
import type { ResearchEvent } from "./research-types";

describe("report citation helpers", () => {
  it("uses first occurrence across streamed claims, matching report citation numbering", () => {
    const events: ResearchEvent[] = [
      { type: "claim_delta", payload: { evidenceIds: ["evidence-1", "evidence-2"] } },
      { type: "claim_delta", payload: { evidenceIds: ["evidence-2", "evidence-3"] } },
    ];
    expect(evidenceIdForCitation(events, 1)).toBe("evidence-1");
    expect(evidenceIdForCitation(events, 2)).toBe("evidence-2");
    expect(evidenceIdForCitation(events, 3)).toBe("evidence-3");
  });

  it("uses the persisted report appendix ahead of streamed claim ordering", () => {
    const events: ResearchEvent[] = [{ type: "claim_delta", payload: { evidenceIds: ["streamed-evidence"] } }];
    expect(evidenceIdForCitation(events, 1, [{
      number: 1,
      evidenceId: "c0b4e197-06fe-4d5a-9ddd-5104f6bb3f82",
      title: "Final report evidence",
      locator: "p. 12",
      sourceUrl: null,
      asOfDate: "2026-08-15",
      license: "SEC EDGAR",
    }])).toBe("c0b4e197-06fe-4d5a-9ddd-5104f6bb3f82");
  });

  it("shows the latest terminal answer", () => {
    const events: ResearchEvent[] = [{ type: "completed", payload: { answer: "first" } }, { type: "abstained", payload: { answer: "latest" } }];
    expect(terminalAnswer(events)).toBe("latest");
  });
});
