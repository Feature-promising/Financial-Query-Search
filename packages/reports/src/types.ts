import type { Claim, EvidenceItem, ResearchReport, ResearchScope } from "@research/contracts";

export interface ReportCitation {
  number: number;
  evidenceId: string;
  title: string;
  locator: string;
  sourceUrl: string | null;
  asOfDate: string | null;
  license: string;
}

export interface ResearchReportDocument {
  markdown: string;
  citations: ReportCitation[];
}

export interface ReportComposer {
  compose(input: { question: string; claims: Claim[]; evidence: EvidenceItem[]; scope: ResearchScope }): ResearchReportDocument;
}

export interface ReportStore {
  /** ownerUserId is the creator of the conversation that owns the parent run. */
  create(scope: ResearchScope, input: Omit<ResearchReport, "id" | "version" | "createdAt"> & { id?: string; ownerUserId: string }): Promise<ResearchReport>;
  get(scope: ResearchScope, id: string): Promise<ResearchReport | undefined>;
  getByRun(scope: ResearchScope, runId: string): Promise<ResearchReport | undefined>;
}
