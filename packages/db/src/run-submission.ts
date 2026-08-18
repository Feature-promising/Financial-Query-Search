import { randomUUID } from "node:crypto";
import type { ResearchRunCommand, RunBudget } from "@research/contracts";
import type { OutboxSqlClient } from "./outbox.js";

export interface RunSubmission {
  runId: string;
  organizationId: string;
  actorUserId: string;
  isOrganizationAdmin: boolean;
  conversationId: string;
  question: string;
  budget: RunBudget;
  command: ResearchRunCommand;
  maxActiveRunsPerUser: number;
  maxActiveRunsPerOrganization: number;
}

export type RunSubmissionResult = "submitted" | "not_found" | "conversation_archived" | "active_run_limit_exceeded";

export interface RunSubmissionStore {
  submit(input: RunSubmission): Promise<RunSubmissionResult>;
}

/**
 * Writes the user message, queued run, and outbox command in one PostgreSQL
 * statement. A committed run can therefore always be discovered and sent by
 * an outbox publisher; an uncommitted run is invisible to both.
 */
export class PostgresRunSubmissionStore implements RunSubmissionStore {
  constructor(private readonly client: OutboxSqlClient) {}

  async submit(input: RunSubmission): Promise<RunSubmissionResult> {
    const result = await this.client.query<{ submission: RunSubmissionResult }>(
      `WITH quota_lock AS (
         SELECT pg_advisory_xact_lock(hashtext($2))
       ), authorized_conversation AS (
         SELECT id, archived_at FROM conversations
         WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL AND (created_by = $3 OR $4::boolean)
       ), active_runs AS (
         SELECT
           count(*) FILTER (WHERE COALESCE(r.state #>> '{command,scope,userId}', c.created_by) = $3) AS user_active,
           count(*) AS organization_active
         FROM research_runs r
         JOIN conversations c ON c.id = r.conversation_id
         CROSS JOIN quota_lock
         WHERE r.organization_id = $2 AND r.status IN ('queued', 'running')
       ), quota_eligible_conversation AS (
         SELECT ac.id
         FROM authorized_conversation ac
         CROSS JOIN active_runs ar
         WHERE ac.archived_at IS NULL AND ar.user_active < $11 AND ar.organization_active < $12
       ), selected_conversation AS (
         UPDATE conversations c SET updated_at = now()
         FROM quota_eligible_conversation qec
         WHERE c.id = qec.id
         RETURNING c.id
       ), created_run AS (
         INSERT INTO research_runs (id, conversation_id, organization_id, status, question, budget, state)
         SELECT $5, id, $2, 'queued', $6, $7, jsonb_build_object('command', $10::jsonb) FROM selected_conversation
         RETURNING id, conversation_id
       ), created_message AS (
         INSERT INTO messages (conversation_id, organization_id, role, content, run_id)
         SELECT conversation_id, $2, 'user', $8, id FROM created_run
         RETURNING id
       ), created_outbox AS (
         INSERT INTO outbox_events (id, event_type, aggregate_id, organization_id, payload)
         SELECT $9, 'research_run_requested', id, $2, $10 FROM created_run
         RETURNING id
       )
       SELECT CASE
         WHEN EXISTS(SELECT 1 FROM created_outbox) THEN 'submitted'
         WHEN EXISTS(SELECT 1 FROM authorized_conversation WHERE archived_at IS NOT NULL) THEN 'conversation_archived'
         WHEN EXISTS(SELECT 1 FROM authorized_conversation) THEN 'active_run_limit_exceeded'
         ELSE 'not_found'
       END AS submission`,
      [input.conversationId, input.organizationId, input.actorUserId, input.isOrganizationAdmin, input.runId, input.question, input.budget, input.question, randomUUID(), input.command, input.maxActiveRunsPerUser, input.maxActiveRunsPerOrganization],
    );
    return result.rows[0]?.submission ?? "not_found";
  }
}
