import { ResearchRunCommandSchema, type ResearchRunCommand } from "@research/contracts";
import type { OutboxSqlClient } from "./outbox.js";

/**
 * Resolves the immutable command committed in the API transaction. Queue
 * transport is at-least-once and is not an authority for actor permissions.
 */
export interface ResearchRunCommandResolver {
  resolve(runId: string): Promise<ResearchRunCommand | undefined>;
}

export class PostgresResearchRunCommandResolver implements ResearchRunCommandResolver {
  constructor(private readonly client: OutboxSqlClient) {}

  async resolve(runId: string): Promise<ResearchRunCommand | undefined> {
    const result = await this.client.query<{ payload: unknown }>(
      `SELECT COALESCE(
         run.state->'command',
         (SELECT event.payload FROM outbox_events event
          WHERE event.event_type = 'research_run_requested' AND event.aggregate_id = run.id
            AND event.organization_id = run.organization_id
          ORDER BY event.occurred_at DESC, event.id DESC
          LIMIT 1)
       ) AS payload
       FROM research_runs run
       WHERE run.id = $1`,
      [runId],
    );
    const payload = result.rows[0]?.payload;
    if (payload === undefined) return undefined;
    return ResearchRunCommandSchema.parse(payload);
  }
}
