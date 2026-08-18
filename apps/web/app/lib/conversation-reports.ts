import type { ConversationDetailView } from "./research-types";

/** Returns the newest assistant turn that can have a published research report. */
export function latestAssistantReportRunId(conversation: ConversationDetailView): string | undefined {
  return [...conversation.messages].reverse().find((message) => message.role === "assistant" && message.runId)?.runId;
}
