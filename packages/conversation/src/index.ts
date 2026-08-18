import { randomUUID } from "node:crypto";
import { canAccessOwnedResource, type ResearchScope } from "@research/contracts";
import { decodeConversationPageCursor, encodeConversationPageCursor, isAfterConversationPageCursor } from "./page-cursor.js";

export { PostgresConversationStore } from "./postgres-store.js";
export { decodeConversationPageCursor, encodeConversationPageCursor } from "./page-cursor.js";

export interface Conversation {
  id: string;
  organizationId: string;
  createdBy: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  runId?: string;
  createdAt: string;
}

export interface ConversationPageOptions {
  archived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ConversationPage {
  conversations: Conversation[];
  nextCursor?: string;
}

export interface ConversationStore {
  create(scope: ResearchScope, title?: string): Promise<Conversation>;
  list(scope: ResearchScope, archived?: boolean, limit?: number): Promise<Conversation[]>;
  listPage(scope: ResearchScope, options?: ConversationPageOptions): Promise<ConversationPage>;
  get(scope: ResearchScope, conversationId: string): Promise<Conversation | undefined>;
  rename(scope: ResearchScope, conversationId: string, title: string): Promise<Conversation | undefined>;
  setArchived(scope: ResearchScope, conversationId: string, archived: boolean): Promise<Conversation | undefined>;
  delete(scope: ResearchScope, conversationId: string): Promise<boolean>;
  listMessages(scope: ResearchScope, conversationId: string, limit?: number): Promise<ConversationMessage[]>;
  appendMessage(scope: ResearchScope, message: Omit<ConversationMessage, "id" | "createdAt">): Promise<ConversationMessage>;
  /**
   * Records the terminal response of a run that was already authorized and
   * started. This is deliberately separate from user-message appends: users
   * cannot add work to an archived conversation, but archiving or hiding a
   * conversation must not strand an in-flight run without its audit record.
   */
  appendPublishedAssistantMessage(scope: ResearchScope, message: Omit<ConversationMessage, "id" | "createdAt" | "role">): Promise<ConversationMessage>;
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly messages = new Map<string, ConversationMessage[]>();

  async create(scope: ResearchScope, title = "New research conversation"): Promise<Conversation> {
    const now = new Date().toISOString();
    const conversation = { id: randomUUID(), organizationId: scope.organizationId, createdBy: scope.userId, title, createdAt: now, updatedAt: now, archivedAt: null };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async list(scope: ResearchScope, archived = false, limit = 50): Promise<Conversation[]> {
    return (await this.listPage(scope, { archived, limit })).conversations;
  }

  async listPage(scope: ResearchScope, options: ConversationPageOptions = {}): Promise<ConversationPage> {
    const archived = options.archived ?? false;
    const limit = boundedPageLimit(options.limit);
    const cursor = options.cursor ? decodeConversationPageCursor(options.cursor) : undefined;
    const snapshotAt = cursor?.snapshotAt ?? new Date().toISOString();
    const eligible = [...this.conversations.values()]
      .filter((conversation) => !conversation.deletedAt && conversation.updatedAt <= snapshotAt && canAccessOwnedResource(scope, conversation.organizationId, conversation.createdBy) && Boolean(conversation.archivedAt) === archived)
      .sort(compareConversationPageOrder)
      .filter((conversation) => !cursor || isAfterConversationPageCursor(conversation, cursor));
    const page = eligible.slice(0, limit);
    const last = page.at(-1);
    return { conversations: page.map(toPublicConversation), ...(eligible.length > page.length && last ? { nextCursor: encodeConversationPageCursor({ ...last, snapshotAt }) } : {}) };
  }

  async get(scope: ResearchScope, conversationId: string): Promise<Conversation | undefined> {
    const conversation = this.conversations.get(conversationId);
    return conversation && !conversation.deletedAt && canAccessOwnedResource(scope, conversation.organizationId, conversation.createdBy)
      ? toPublicConversation(conversation)
      : undefined;
  }

  async rename(scope: ResearchScope, conversationId: string, title: string): Promise<Conversation | undefined> {
    const conversation = await this.get(scope, conversationId);
    if (!conversation) return undefined;
    const updated = { ...conversation, title, updatedAt: new Date().toISOString() };
    this.conversations.set(conversationId, updated);
    return updated;
  }

  async setArchived(scope: ResearchScope, conversationId: string, archived: boolean): Promise<Conversation | undefined> {
    const conversation = await this.get(scope, conversationId);
    if (!conversation) return undefined;
    const updated = { ...conversation, archivedAt: archived ? new Date().toISOString() : null, updatedAt: new Date().toISOString() };
    this.conversations.set(conversationId, updated);
    return updated;
  }

  async delete(scope: ResearchScope, conversationId: string): Promise<boolean> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.deletedAt || !canAccessOwnedResource(scope, conversation.organizationId, conversation.createdBy)) return false;
    this.conversations.set(conversationId, { ...conversation, deletedAt: new Date().toISOString(), deletedBy: scope.userId, updatedAt: new Date().toISOString() });
    return true;
  }

  async listMessages(scope: ResearchScope, conversationId: string, limit = 30): Promise<ConversationMessage[]> {
    await this.requireConversation(scope, conversationId);
    return (this.messages.get(conversationId) ?? []).slice(-limit);
  }

  async appendMessage(scope: ResearchScope, message: Omit<ConversationMessage, "id" | "createdAt">): Promise<ConversationMessage> {
    const conversation = await this.requireConversation(scope, message.conversationId);
    if (conversation.archivedAt) throw new ConversationArchivedError();
    return this.append(scope, conversation, message);
  }

  async appendPublishedAssistantMessage(scope: ResearchScope, message: Omit<ConversationMessage, "id" | "createdAt" | "role">): Promise<ConversationMessage> {
    const conversation = this.requireOwnedConversation(scope, message.conversationId);
    return this.append(scope, conversation, { ...message, role: "assistant" });
  }

  private async requireConversation(scope: ResearchScope, conversationId: string): Promise<Conversation> {
    const conversation = await this.get(scope, conversationId);
    if (!conversation) throw new Error("conversation not found");
    return conversation;
  }

  private requireOwnedConversation(scope: ResearchScope, conversationId: string): StoredConversation {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || !canAccessOwnedResource(scope, conversation.organizationId, conversation.createdBy)) throw new Error("conversation not found");
    return conversation;
  }

  private append(_scope: ResearchScope, conversation: Conversation, message: Omit<ConversationMessage, "id" | "createdAt">): ConversationMessage {
    const stored = { ...message, id: randomUUID(), createdAt: new Date().toISOString() };
    this.messages.set(message.conversationId, [...(this.messages.get(message.conversationId) ?? []), stored]);
    const existing = this.conversations.get(conversation.id);
    if (existing) this.conversations.set(conversation.id, { ...existing, updatedAt: stored.createdAt });
    return stored;
  }
}

interface StoredConversation extends Conversation {
  deletedAt?: string;
  deletedBy?: string;
}

function toPublicConversation(conversation: StoredConversation): Conversation {
  const { deletedAt: _deletedAt, deletedBy: _deletedBy, ...publicConversation } = conversation;
  return publicConversation;
}

function boundedPageLimit(limit = 50): number {
  return Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 100) : 50;
}

function compareConversationPageOrder(left: Conversation, right: Conversation): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
}


/** Archived conversations remain readable, but must be restored before new research is added. */
export class ConversationArchivedError extends Error {
  constructor() {
    super("conversation is archived");
    this.name = "ConversationArchivedError";
  }
}
