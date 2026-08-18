import { buildContext } from "@research/knowledge";
import type { Claim, EvidenceItem, ResearchScope } from "@research/contracts";
import { BedrockClaimComposer } from "./claims.js";
import type { StructuredModel } from "./bedrock.js";

/**
 * The only production claim-composition boundary. It applies the same
 * entitlement and prompt-injection rules used by retrieval before source text
 * is supplied to the model. Empty safe context deliberately produces no claims.
 */
export class EvidenceBoundClaimComposer {
  private readonly delegate: BedrockClaimComposer;

  constructor(model: StructuredModel, private readonly contextTokenBudget = 8_000) {
    this.delegate = new BedrockClaimComposer(model);
  }

  async compose(question: string, evidence: EvidenceItem[], scope: ResearchScope, signal?: AbortSignal): Promise<Claim[]> {
    const permittedEvidence = buildContext(scope, evidence, this.contextTokenBudget);
    if (permittedEvidence.length === 0) return [];
    return this.delegate.compose(question, permittedEvidence, signal);
  }
}
