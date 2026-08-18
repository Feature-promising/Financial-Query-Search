import type { EvidenceItem } from "@research/contracts";

export interface FinancialEvidenceConflict {
  /** Stable canonical dimensions; raw values remain in authorized evidence only. */
  key: {
    entity: string;
    period: string;
    sourceAsOf: string;
    metric: string;
    currency: string;
    unit: string;
  };
  evidenceIds: string[];
}

interface FinancialMetricObservation {
  evidenceId: string;
  key: FinancialEvidenceConflict["key"];
  value: string;
}

/**
 * Detects incompatible canonical warehouse values before they can support a
 * claim. A conflict is deliberately narrow: it requires the same entity,
 * period, source-as-of date, metric, currency, and unit. Different source
 * dates represent revisions, not a conflict that this generic gate can judge.
 */
export function findFinancialEvidenceConflicts(evidence: EvidenceItem[]): FinancialEvidenceConflict[] {
  const groups = new Map<string, Map<string, FinancialMetricObservation[]>>();
  for (const item of evidence) {
    for (const observation of financialMetricObservations(item)) {
      const key = stableKey(observation.key);
      const values = groups.get(key) ?? new Map<string, FinancialMetricObservation[]>();
      values.set(observation.value, [...(values.get(observation.value) ?? []), observation]);
      groups.set(key, values);
    }
  }

  return [...groups.values()].flatMap((values) => {
    if (values.size < 2) return [];
    const observations = [...values.values()].flat();
    const first = observations[0];
    if (!first) return [];
    return [{ key: first.key, evidenceIds: [...new Set(observations.map((item) => item.evidenceId))].sort() }];
  }).sort((left, right) => stableKey(left.key).localeCompare(stableKey(right.key)));
}

function financialMetricObservations(item: EvidenceItem): FinancialMetricObservation[] {
  if (item.sourceType !== "market_data" || !item.entity) return [];
  const record = parseRecord(item.content);
  if (!record) return [];
  const period = stringField(record, "fiscal_period") ?? stringField(record, "trade_date") ?? metadataString(item, "fiscalPeriod");
  const sourceAsOf = stringField(record, "source_as_of") ?? metadataString(item, "sourceAsOf") ?? item.asOfDate ?? undefined;
  const currency = stringField(record, "currency") ?? metadataString(item, "currency");
  const unit = stringField(record, "unit") ?? metadataString(item, "unit");
  if (!period || !sourceAsOf || !currency || !unit) return [];

  const namedMetric = stringField(record, "metric_name");
  return Object.entries(record).flatMap(([field, value]) => {
    const numeric = canonicalNumber(value);
    if (numeric === undefined || ignoredFinancialField(field)) return [];
    const metric = field === "metric_value" && namedMetric ? namedMetric : field;
    return [{
      evidenceId: item.id,
      key: { entity: item.entity!, period, sourceAsOf, metric, currency, unit },
      value: numeric,
    }];
  });
}

function parseRecord(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function metadataString(item: EvidenceItem, key: string): string | undefined {
  const value = item.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function canonicalNumber(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string" || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : undefined;
}

function ignoredFinancialField(field: string): boolean {
  return new Set(["ticker", "fiscal_period", "trade_date", "source_as_of", "currency", "unit", "metric_name"]).has(field);
}

function stableKey(key: FinancialEvidenceConflict["key"]): string {
  return [key.entity, key.period, key.sourceAsOf, key.metric, key.currency, key.unit].join("\u0000");
}
