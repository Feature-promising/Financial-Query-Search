import type { ConfirmedPreference, ConversationDetailView as ContractConversationDetailView, ConversationView as ContractConversationView, EvidenceView as ContractEvidenceView, ResearchReportView as ContractResearchReportView, ResearchRunView as ContractResearchRunView, RunEvent } from "@research/contracts";

export type { ConfirmedPreference };

/** UI projection of an already contract-validated server event. */
export type ResearchEvent = {
  type: RunEvent["type"];
  payload: Record<string, unknown>;
  runId?: string;
  sequence?: number;
};

export type EvidenceView = ContractEvidenceView;
export type ConversationView = ContractConversationView;
export type ConversationDetailView = ContractConversationDetailView;

/** Authoritative, versioned report returned only after Worker publication. */
export type ResearchReportView = ContractResearchReportView;
export type ResearchRunView = ContractResearchRunView;
