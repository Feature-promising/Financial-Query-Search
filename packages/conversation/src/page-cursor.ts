/**
 * Stable keyset cursor for a user's own conversation collection. The cursor
 * only represents sort position; tenant and visibility authorization remain
 * mandatory predicates in every store query.
 */
export interface ConversationPageAnchor {
  snapshotAt: string;
  updatedAt: string;
  id: string;
}

export function encodeConversationPageCursor(conversation: ConversationPageAnchor): string {
  return `${conversation.snapshotAt}|${conversation.updatedAt}|${conversation.id}`;
}

export function decodeConversationPageCursor(cursor: string): ConversationPageAnchor {
  const [snapshotAt, updatedAt, id, extra] = cursor.split("|");
  if (!snapshotAt || !updatedAt || !id || extra !== undefined || Number.isNaN(new Date(snapshotAt).getTime()) || Number.isNaN(new Date(updatedAt).getTime()) || !isUuid(id)) {
    throw new Error("invalid conversation page cursor");
  }
  return { snapshotAt, updatedAt, id };
}

export function isAfterConversationPageCursor(conversation: Pick<ConversationPageAnchor, "updatedAt" | "id">, cursor: Pick<ConversationPageAnchor, "updatedAt" | "id">): boolean {
  return conversation.updatedAt < cursor.updatedAt || (conversation.updatedAt === cursor.updatedAt && conversation.id < cursor.id);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
