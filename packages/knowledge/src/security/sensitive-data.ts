import type { EvidenceItem } from "@research/contracts";

export type SensitiveDataType = "api_key" | "credit_card" | "email" | "phone" | "private_key" | "ssn";

export interface SensitiveDataRedaction {
  version: "sensitive-data-v1";
  detected: boolean;
  types: SensitiveDataType[];
  count: number;
}

export interface RedactedText {
  text: string;
  assessment: SensitiveDataRedaction;
}

/**
 * Removes high-risk credentials and personal identifiers from model-bound
 * text. It intentionally does not mutate persisted source evidence: original
 * evidence remains available only through the authorized evidence endpoint.
 */
export function redactSensitiveText(input: string): RedactedText {
  const types = new Set<SensitiveDataType>();
  let count = 0;
  const redact = (pattern: RegExp, type: SensitiveDataType, text: string): string => text.replace(pattern, () => {
    types.add(type);
    count += 1;
    return `[REDACTED:${type}]`;
  });

  let text = input;
  text = redact(/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g, "private_key", text);
  text = redact(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "api_key", text);
  text = redact(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi, "api_key", text);
  text = redact(/\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{8,}/gi, "api_key", text);
  text = redact(/\b\d{3}-\d{2}-\d{4}\b/g, "ssn", text);
  text = redact(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "email", text);
  text = redact(/\b(?:phone|tel|mobile)\s*[:=]?\s*(?:\+?1[ .-]?)?(?:\(?\d{3}\)?[ .-]?)\d{3}[ .-]\d{4}\b/gi, "phone", text);
  text = redactPaymentCardNumbers(text, types, () => { count += 1; });
  return { text, assessment: { version: "sensitive-data-v1", detected: count > 0, types: [...types].sort(), count } };
}

/** Builds an evidence clone safe for LLM context while retaining citation ID and locator. */
export function redactEvidenceForModel(item: EvidenceItem): EvidenceItem {
  const content = redactSensitiveText(item.content);
  const title = redactSensitiveText(item.title);
  const locator = redactSensitiveText(item.locator);
  const assessment = combineAssessments([content.assessment, title.assessment, locator.assessment]);
  return {
    ...item,
    content: content.text,
    title: title.text,
    locator: locator.text,
    metadata: { ...item.metadata, sensitiveDataRedaction: assessment },
  };
}

function combineAssessments(assessments: SensitiveDataRedaction[]): SensitiveDataRedaction {
  const types = new Set<SensitiveDataType>();
  let count = 0;
  for (const assessment of assessments) {
    assessment.types.forEach((type) => types.add(type));
    count += assessment.count;
  }
  return { version: "sensitive-data-v1", detected: count > 0, types: [...types].sort(), count };
}

function redactPaymentCardNumbers(text: string, types: Set<SensitiveDataType>, increment: () => void): string {
  return text.replace(/\b(?:\d[ -]?){13,19}\b/g, (candidate) => {
    const digits = candidate.replace(/\D/g, "");
    if (!isLuhnValid(digits)) return candidate;
    types.add("credit_card");
    increment();
    return "[REDACTED:credit_card]";
  });
}

function isLuhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let total = 0;
  for (let index = digits.length - 1, alternate = false; index >= 0; index -= 1, alternate = !alternate) {
    let value = Number(digits[index]);
    if (alternate) value = value > 4 ? value * 2 - 9 : value * 2;
    total += value;
  }
  return total % 10 === 0;
}
