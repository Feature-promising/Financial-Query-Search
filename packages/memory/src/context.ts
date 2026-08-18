import type { MemoryRecord } from "@research/contracts";
import { toConfirmedPreference } from "./preferences.js";
import type { MemoryStore } from "./types.js";

/**
 * Deliberately separated memory layers supplied to the Agent runtime.
 * Consumers must treat research assets as retrieval leads, not factual proof.
 */
export interface PrioritizedMemoryContext {
  sessionFacts: MemoryRecord[];
  researchAssets: MemoryRecord[];
  userPreferences: MemoryRecord[];
}

export interface LoadMemoryContextInput {
  tenantId: string;
  userId: string;
  conversationId: string;
  question: string;
  perLayerLimit?: number;
}

/**
 * Loads each layer independently instead of letting recency flatten its
 * meaning. The explicit structure preserves the runtime priority:
 * active question -> current session -> research assets -> preferences.
 */
export async function loadPrioritizedMemoryContext(
  store: MemoryStore,
  input: LoadMemoryContextInput,
): Promise<PrioritizedMemoryContext> {
  const limit = Math.min(input.perLayerLimit ?? 4, 20);
  const researchTerms = extractResearchTerms(input.question);
  const [sessionFacts, researchAssets, longTermRecords] = await Promise.all([
    store.retrieve({
      tenantId: input.tenantId,
      userId: input.userId,
      scopes: ["short_term"],
      conversationId: input.conversationId,
      limit,
    }),
    store.retrieve({
      tenantId: input.tenantId,
      userId: input.userId,
      scopes: ["research"],
      ...(researchTerms.length ? { researchTerms } : { text: input.question }),
      limit,
    }),
    store.retrieve({
      tenantId: input.tenantId,
      userId: input.userId,
      scopes: ["long_term"],
      limit,
    }),
  ]);
  // Long-term records reach the Planner only when a user explicitly confirmed
  // one of the closed preference contracts. Other durable records stay out of
  // the model context and may be used only through their intended workflows.
  const userPreferences = longTermRecords.filter((record) => (
    record.userId === input.userId
    && record.visibility === "private"
    && toConfirmedPreference(record) !== undefined
  ));
  return { sessionFacts, researchAssets, userPreferences };
}

/** Entity/ticker-only metadata lookup avoids promoting a loose report body match into context. */
function extractResearchTerms(question: string): string[] {
  const tickerOrAcronym = question.match(/\b[A-Z]{2,10}\b/g) ?? [];
  const capitalizedWords = question.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
  return [...new Set([...tickerOrAcronym, ...capitalizedWords])].slice(0, 10);
}

export function emptyPrioritizedMemoryContext(): PrioritizedMemoryContext {
  return { sessionFacts: [], researchAssets: [], userPreferences: [] };
}
