import type { ResearchScope } from "@research/contracts";
import { decodeConversationPageCursor, encodeConversationPageCursor } from "./page-cursor.js";
import type { Conversation, ConversationMessage, ConversationPage, ConversationPageOptions, ConversationStore } from "./index.js";

export interface SqlClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export class PostgresConversationStore implements ConversationStore {
  constructor(private readonly client: SqlClient) {}

  async create(scope: ResearchScope, title = "New research conversation"): Promise<Conversation> {
    const result = await this.client.query<Record<string, unknown>>(
      `INSERT INTO conversations (organization_id, created_by, title) VALUES ($1, $2, $3) RETURNING *`,
      [scope.organizationId, scope.userId, title],
    );
    return toConversation(result.rows[0]);
  }

  async list(scope: ResearchScope, archived = false, limit = 50): Promise<Conversation[]> {
    return (await this.listPage(scope, { archived, limit })).conversations;
  }

  async listPage(scope: ResearchScope, options: ConversationPageOptions = {}): Promise<ConversationPage> {
    const archived = options.archived ?? false;
    const limit = boundedPageLimit(options.limit);
    const cursor = options.cursor ? decodeConversationPageCursor(options.cursor) : undefined;
    const snapshotAt = cursor?.snapshotAt ?? new Date().toISOString();
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT * FROM conversations
       WHERE organization_id = $1 AND deleted_at IS NULL AND (created_by = $2 OR $3::boolean)
         AND (archived_at IS ${archived ? "NOT " : ""}NULL)
         AND updated_at <= $4::timestamptz
         AND ($5::timestamptz IS NULL OR (updated_at, id) < ($5::timestamptz, $6::uuid))
       ORDER BY updated_at DESC, id DESC LIMIT $7`,
      [scope.organizationId, scope.userId, scope.roles.includes("admin"), snapshotAt, cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const rows = result.rows.slice(0, limit).map(toConversation);
    const last = rows.at(-1);
    return { conversations: rows, ...(result.rows.length > rows.length && last ? { nextCursor: encodeConversationPageCursor({ ...last, snapshotAt }) } : {}) };
  }

  async get(scope: ResearchScope, conversationId: string): Promise<Conversation | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT * FROM conversations
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL AND (created_by = $3 OR $4::boolean)`,
      [conversationId, scope.organizationId, scope.userId, scope.roles.includes("admin")],
    );
    return result.rows[0] ? toConversation(result.rows[0]) : undefined;
  }

  async rename(scope: ResearchScope, conversationId: string, title: string): Promise<Conversation | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `UPDATE conversations SET title=$5, updated_at=now()
       WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL AND (created_by=$3 OR $4::boolean) RETURNING *`,
      [conversationId, scope.organizationId, scope.userId, scope.roles.includes("admin"), title],
    );
    return result.rows[0] ? toConversation(result.rows[0]) : undefined;
  }

  async setArchived(scope: ResearchScope, conversationId: string, archived: boolean): Promise<Conversation | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `UPDATE conversations SET archived_at=CASE WHEN $5::boolean THEN now() ELSE NULL END, updated_at=now()
       WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL AND (created_by=$3 OR $4::boolean) RETURNING *`,
      [conversationId, scope.organizationId, scope.userId, scope.roles.includes("admin"), archived],
    );
    return result.rows[0] ? toConversation(result.rows[0]) : undefined;
  }

  async delete(scope: ResearchScope, conversationId: string): Promise<boolean> {
    const result = await this.client.query<Record<string, unknown>>(
      `UPDATE conversations SET deleted_at=now(), deleted_by=$5, updated_at=now()
       WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL AND (created_by=$3 OR $4::boolean)`,
      [conversationId, scope.organizationId, scope.userId, scope.roles.includes("admin"), scope.userId],
    );
    return result.rowCount === 1;
  }

  async listMessages(scope: ResearchScope, conversationId: string, limit = 30): Promise<ConversationMessage[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id = $1 AND m.organization_id = $2 AND c.organization_id = $2 AND (c.created_by = $3 OR $4::boolean)
       ORDER BY m.created_at ASC LIMIT $5`,
      [conversationId, scope.organizationId, scope.userId, scope.roles.includes("admin"), Math.min(limit, 100)],
    );
    return result.rows.map(toMessage);
  }

  async appendMessage(scope: ResearchScope, message: Omit<ConversationMessage, "id" | "createdAt">): Promise<ConversationMessage> {
    const result = await this.client.query<Record<string, unknown>>(
      `INSERT INTO messages (conversation_id, organization_id, role, content, run_id)
       SELECT id, $2, $5, $6, $7 FROM conversations
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL AND archived_at IS NULL
         AND (created_by = $3 OR $4::boolean) RETURNING *`,
      [message.conversationId, scope.organizationId, scope.userId, scope.roles.includes("admin"), message.role, message.content, message.runId ?? null],
    );
    if (!result.rows[0]) throw new Error("conversation not found");
    await this.client.query(`UPDATE conversations SET updated_at = now() WHERE id = $1 AND organization_id = $2 AND (created_by = $3 OR $4::boolean)`, [message.conversationId, scope.organizationId, scope.userId, scope.roles.includes("admin")]);
    return toMessage(result.rows[0]);
  }

  async appendPublishedAssistantMessage(scope: ResearchScope, message: Omit<ConversationMessage, "id" | "createdAt" | "role">): Promise<ConversationMessage> {
    const result = await this.client.query<Record<string, unknown>>(
      `INSERT INTO messages (conversation_id, organization_id, role, content, run_id)
       SELECT id, $2, 'assistant', $5, $6 FROM conversations
       WHERE id = $1 AND organization_id = $2 AND (created_by = $3 OR $4::boolean) RETURNING *`,
      [message.conversationId, scope.organizationId, scope.userId, scope.roles.includes("admin"), message.content, message.runId ?? null],
    );
    if (!result.rows[0]) throw new Error("conversation not found");
    await this.client.query(`UPDATE conversations SET updated_at = now() WHERE id = $1 AND organization_id = $2 AND (created_by = $3 OR $4::boolean)`, [message.conversationId, scope.organizationId, scope.userId, scope.roles.includes("admin")]);
    return toMessage(result.rows[0]);
  }
}

function toConversation(row: Record<string, unknown>): Conversation {
  return { id: String(row.id), organizationId: String(row.organization_id), createdBy: String(row.created_by), title: String(row.title), createdAt: asIso(row.created_at), updatedAt: asIso(row.updated_at), archivedAt: row.archived_at == null ? null : asIso(row.archived_at) };
}

function toMessage(row: Record<string, unknown>): ConversationMessage {
  return { id: String(row.id), conversationId: String(row.conversation_id), role: row.role === "assistant" ? "assistant" : "user", content: String(row.content), runId: row.run_id == null ? undefined : String(row.run_id), createdAt: asIso(row.created_at) };
}

function asIso(value: unknown): string { return new Date(String(value)).toISOString(); }

function boundedPageLimit(limit = 50): number {
  return Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 100) : 50;
}
