import { ConfirmedPreferenceSchema, type ConfirmedPreference, type MemoryRecord } from "@research/contracts";
import { isConfirmedPreferenceStore, type MemoryStore } from "./types.js";

const PREFERENCE_METADATA_KEY = "preferenceKey";
const PREFERENCE_VALUE_METADATA_KEY = "preferenceValue";

export interface UserPreferenceScope {
  tenantId: string;
  userId: string;
}

/**
 * Controls the sole write path for durable user preferences. It intentionally
 * accepts only user-confirmed, structured preferences and keeps them private.
 */
export class UserPreferenceMemoryService {
  constructor(private readonly store: MemoryStore) {}

  async save(scope: UserPreferenceScope, preference: ConfirmedPreference): Promise<ConfirmedPreference> {
    const record = {
      scope: "long_term" as const,
      tenantId: scope.tenantId,
      userId: scope.userId,
      visibility: "private" as const,
      content: renderConfirmedPreferenceContent(preference),
      sourceRunId: null,
      expiresAt: null,
      retentionPolicy: "user_managed" as const,
      metadata: {
        userConfirmed: true,
        [PREFERENCE_METADATA_KEY]: preference.key,
        [PREFERENCE_VALUE_METADATA_KEY]: preference.value,
      },
    };
    if (isConfirmedPreferenceStore(this.store)) {
      await this.store.upsertConfirmedPreference(record);
      return preference;
    }
    // Alternative adapters without an atomic preference operation retain a
    // compatibility fallback. Production PostgreSQL always takes the branch above.
    const existing = await this.find(scope, preference.key);
    if (existing) {
      await this.store.update(existing.id, scope.tenantId, { content: record.content, metadata: record.metadata, expiresAt: null });
    } else {
      await this.store.save(record);
    }
    return preference;
  }

  async list(scope: UserPreferenceScope): Promise<ConfirmedPreference[]> {
    const records = await this.store.retrieve({ tenantId: scope.tenantId, userId: scope.userId, scopes: ["long_term"], limit: 100 });
    const preferences = records
      .filter((record) => record.userId === scope.userId && record.visibility === "private")
      .flatMap((record) => toConfirmedPreference(record) ?? []);
    // Deduplication remains defensive for pre-migration history and alternative
    // adapters; PostgreSQL enforces atomic uniqueness from migration 0008.
    return [...new Map(preferences.map((preference) => [preference.key, preference])).values()];
  }

  private async find(scope: UserPreferenceScope, key: ConfirmedPreference["key"]): Promise<MemoryRecord | undefined> {
    const records = await this.store.retrieve({ tenantId: scope.tenantId, userId: scope.userId, scopes: ["long_term"], limit: 100 });
    return records.find((record) => record.userId === scope.userId && record.visibility === "private" && toConfirmedPreference(record)?.key === key);
  }
}

export function toConfirmedPreference(record: MemoryRecord): ConfirmedPreference | undefined {
  if (record.scope !== "long_term" || record.retentionPolicy !== "user_managed" || record.metadata.userConfirmed !== true) return undefined;
  return ConfirmedPreferenceSchema.safeParse({
    key: record.metadata[PREFERENCE_METADATA_KEY],
    value: record.metadata[PREFERENCE_VALUE_METADATA_KEY],
  }).data;
}

export function renderConfirmedPreferenceContent(preference: ConfirmedPreference): string {
  switch (preference.key) {
    case "valuation_method": return `Confirmed valuation method: ${preference.value}`;
    case "focus_industries": return `Confirmed focus industries: ${preference.value.join(", ")}`;
    case "comparison_framework": return `Confirmed comparison framework: ${preference.value}`;
    case "display_unit": return `Confirmed display unit: ${preference.value}`;
  }
  throw new Error("unsupported confirmed preference");
}
