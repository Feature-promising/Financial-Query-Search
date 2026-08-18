import type { ConversationDetailView } from "./research-types";

/** Archived conversations are immutable reading records until restored. */
export function isConversationArchived(conversation?: ConversationDetailView): boolean {
  return Boolean(conversation?.conversation.archivedAt);
}
