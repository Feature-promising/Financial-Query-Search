import { describe, expect, it } from "vitest";
import { latestAssistantReportRunId } from "./conversation-reports";

describe("latestAssistantReportRunId", () => {
  it("selects the newest assistant run and ignores ordinary user messages", () => {
    const firstRunId = "a424ce0a-e21e-4b42-9027-ccbd521ce811";
    const latestRunId = "144d8a8a-cd10-49a9-ab1f-7a0bff2aa8b8";
    const conversation = {
      conversation: { id: "d7bbbd1b-26db-4703-b039-c14a57902b21", title: "Research", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", archivedAt: null },
      messages: [
        { id: "f6342ff8-dab4-491f-953e-75d0f63d67f8", role: "assistant" as const, content: "First", runId: firstRunId, createdAt: "2026-08-17T00:00:00.000Z" },
        { id: "c1b9ccb4-7d24-4b6c-9afb-ddb0d819b9ee", role: "user" as const, content: "Follow-up", runId: latestRunId, createdAt: "2026-08-17T00:01:00.000Z" },
        { id: "05e2cb5d-5365-4d23-b7b9-e6a2d832e632", role: "assistant" as const, content: "Latest", runId: latestRunId, createdAt: "2026-08-17T00:02:00.000Z" },
      ],
    };

    expect(latestAssistantReportRunId(conversation)).toBe(latestRunId);
  });

  it("does not invent a report target when assistant output is not run-bound", () => {
    const conversation = {
      conversation: { id: "d7bbbd1b-26db-4703-b039-c14a57902b21", title: "Research", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", archivedAt: null },
      messages: [{ id: "f6342ff8-dab4-491f-953e-75d0f63d67f8", role: "assistant" as const, content: "Legacy note", createdAt: "2026-08-17T00:00:00.000Z" }],
    };

    expect(latestAssistantReportRunId(conversation)).toBeUndefined();
  });
});
