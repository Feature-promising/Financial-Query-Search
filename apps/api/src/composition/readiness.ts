import type { ReadinessProbe } from "../readiness.js";

interface SqlClient {
  query(sql: string): Promise<unknown>;
}

/** Minimal bounded database probe; it intentionally does not inspect user data. */
export class PostgresReadinessProbe implements ReadinessProbe {
  constructor(private readonly client: SqlClient) {}

  async check(): Promise<void> {
    await this.client.query("SELECT 1");
  }
}
