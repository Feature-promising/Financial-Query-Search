interface SqlClient { query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>; }

export interface RunCheckpoint {
  runId: string;
  organizationId: string;
  phase: string;
  snapshot: unknown;
  createdAt: string;
}

export interface RunCheckpointSink { save(checkpoint: RunCheckpoint): Promise<void>; }

/** Durable append-only runtime audit checkpoints; no model or tool output is mutated in place. */
export class PostgresRunCheckpointSink implements RunCheckpointSink {
  constructor(private readonly client: SqlClient) {}
  async save(checkpoint: RunCheckpoint): Promise<void> {
    await this.client.query(
      `INSERT INTO research_run_checkpoints (run_id, organization_id, phase, snapshot, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [checkpoint.runId, checkpoint.organizationId, checkpoint.phase, checkpoint.snapshot, checkpoint.createdAt],
    );
  }
  async latest(runId: string, organizationId: string): Promise<{ phase: string } | undefined> {
    const result = await this.client.query<{ phase: string }>("SELECT phase FROM research_run_checkpoints WHERE run_id=$1 AND organization_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1", [runId, organizationId]);
    return result.rows[0];
  }
}
