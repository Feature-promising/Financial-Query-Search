import { randomUUID } from "node:crypto";
import { ResearchReportSchema, type ResearchReport, type ResearchScope } from "@research/contracts";
import type { ReportStore } from "./types.js";

export interface SqlClient { query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>; }

export class PostgresReportStore implements ReportStore {
  constructor(private readonly client: SqlClient) {}
  async create(scope: ResearchScope, input: Parameters<ReportStore["create"]>[1]): Promise<ResearchReport> {
    const result = await this.client.query<Record<string, unknown>>(
      `INSERT INTO research_reports (id, run_id, organization_id, version, markdown, citations)
       SELECT $1, r.id, $3,
         COALESCE((SELECT max(version) FROM research_reports WHERE run_id = r.id AND organization_id = $3), 0) + 1,
         $5, $6
       FROM research_runs r JOIN conversations c ON c.id = r.conversation_id
       WHERE r.id=$2 AND r.organization_id=$3 AND (c.created_by=$4 OR $7::boolean) AND c.created_by=$8
       RETURNING *`,
      [input.id ?? randomUUID(), input.runId, input.organizationId, scope.userId, input.markdown, input.citations, scope.roles.includes("admin"), input.ownerUserId],
    );
    if (!result.rows[0]) throw new Error("unable to create report");
    return toReport(result.rows[0]);
  }
  async get(scope: ResearchScope, id: string): Promise<ResearchReport | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT rr.* FROM research_reports rr JOIN research_runs r ON r.id=rr.run_id JOIN conversations c ON c.id=r.conversation_id
       WHERE rr.id=$1 AND rr.organization_id=$2 AND (c.created_by=$3 OR $4::boolean)`,
      [id, scope.organizationId, scope.userId, scope.roles.includes("admin")],
    );
    return result.rows[0] ? toReport(result.rows[0]) : undefined;
  }
  async getByRun(scope: ResearchScope, runId: string): Promise<ResearchReport | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT rr.* FROM research_reports rr JOIN research_runs r ON r.id=rr.run_id JOIN conversations c ON c.id=r.conversation_id
       WHERE rr.run_id=$1 AND rr.organization_id=$2 AND (c.created_by=$3 OR $4::boolean)
       ORDER BY rr.version DESC LIMIT 1`,
      [runId, scope.organizationId, scope.userId, scope.roles.includes("admin")],
    );
    return result.rows[0] ? toReport(result.rows[0]) : undefined;
  }
}

function toReport(row: Record<string, unknown>): ResearchReport {
  return ResearchReportSchema.parse({ id: row.id, runId: row.run_id, organizationId: row.organization_id, version: row.version, markdown: row.markdown, citations: row.citations, createdAt: new Date(String(row.created_at)).toISOString() });
}
