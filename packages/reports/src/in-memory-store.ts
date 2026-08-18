import { randomUUID } from "node:crypto";
import { canAccessOwnedResource, ResearchReportSchema, type ResearchReport, type ResearchScope } from "@research/contracts";
import type { ReportStore } from "./types.js";

export class InMemoryReportStore implements ReportStore {
  private readonly reports = new Map<string, ResearchReport>();
  private readonly ownersByRun = new Map<string, string>();

  async create(scope: ResearchScope, input: Parameters<ReportStore["create"]>[1]): Promise<ResearchReport> {
    if (scope.organizationId !== input.organizationId) throw new Error("report organization mismatch");
    if (!canAccessOwnedResource(scope, input.organizationId, input.ownerUserId)) throw new Error("run not found");
    const existing = [...this.reports.values()].filter((report) => report.runId === input.runId && report.organizationId === input.organizationId);
    const { ownerUserId, ...reportInput } = input;
    const report = ResearchReportSchema.parse({ ...reportInput, id: input.id ?? randomUUID(), version: existing.length + 1, createdAt: new Date().toISOString() });
    this.reports.set(report.id, report);
    this.ownersByRun.set(report.runId, ownerUserId);
    return report;
  }
  async get(scope: ResearchScope, id: string): Promise<ResearchReport | undefined> {
    const report = this.reports.get(id);
    const owner = report && this.ownersByRun.get(report.runId);
    return report && owner && canAccessOwnedResource(scope, report.organizationId, owner) ? report : undefined;
  }
  async getByRun(scope: ResearchScope, runId: string): Promise<ResearchReport | undefined> {
    return [...this.reports.values()].filter((report) => {
      const owner = this.ownersByRun.get(report.runId);
      return owner && canAccessOwnedResource(scope, report.organizationId, owner) && report.runId === runId;
    }).sort((a, b) => b.version - a.version)[0];
  }
}
