import { createHash } from "node:crypto";
import type { EvidenceItem } from "@research/contracts";
import type { EvidenceRepository } from "@research/knowledge";
import type { SecFiling } from "@research/tools";

export interface SecFilingSource {
  findLatestFiling(ticker: string): Promise<SecFiling | undefined>;
  getFilingText(url: string): Promise<string>;
}

/** Bounded, idempotent SEC ingestion; scheduling remains outside request handling. */
export class SecFilingIngestionService {
  constructor(private readonly source: SecFilingSource, private readonly repository: EvidenceRepository, private readonly maxContentChars = 150_000) {}

  async ingest(ticker: string, tenantId: string): Promise<EvidenceItem | undefined> {
    const filing = await this.source.findLatestFiling(ticker);
    if (!filing) return undefined;
    const content = (await this.source.getFilingText(filing.url)).slice(0, this.maxContentChars).trim();
    if (!content) throw new Error(`SEC filing ${filing.accessionNumber} contained no extractable text`);
    const contentHash = hash(content);
    const evidence: EvidenceItem = {
      id: stableUuid(`${tenantId}:${filing.cik}:${filing.accessionNumber}`), sourceType: "sec_filing", authority: "primary", title: `${filing.companyName} ${filing.form} (${filing.filingDate})`,
      content, sourceUrl: filing.url, locator: `SEC ${filing.form}; accession ${filing.accessionNumber}; primary document ${filing.primaryDocument}`,
      entity: filing.ticker, publishedAt: `${filing.filingDate}T00:00:00.000Z`, asOfDate: filing.reportDate ?? filing.filingDate, retrievedAt: new Date().toISOString(), contentHash,
      license: "SEC EDGAR public filing", tenantId, metadata: { cik: filing.cik, accessionNumber: filing.accessionNumber, filingType: filing.form, reportingPeriod: filing.reportDate, ingestion: "scheduled" },
      graphRelations: [{ subject: filing.ticker, predicate: "ISSUED_BY", object: filing.companyName }],
    };
    return (await this.repository.store([evidence]))[0];
  }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function stableUuid(value: string): string {
  const hash = hashBytes(value);
  const bytes = Buffer.from(hash.slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function hashBytes(value: string): string { return createHash("sha256").update(value).digest("hex"); }
