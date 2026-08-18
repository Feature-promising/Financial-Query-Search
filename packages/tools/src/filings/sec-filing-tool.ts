import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvidenceItem } from "@research/contracts";
import type { Tool } from "../types.js";
import type { ToolContext, ToolResult } from "../types.js";
import { toolFailure } from "../results.js";
import { FilingSearchToolManifest } from "../manifests.js";
import { SecEdgarClient } from "./sec-client.js";
import { chunkFilingText } from "./filing-chunks.js";

const MAX_FILING_EVIDENCE_CHARS = 30_000;

const InputSchema = z.object({ query: z.string().min(1).max(4_000), period: z.string().regex(/^20\d{2}(?:-\d{2}-\d{2})?$/).optional() });
const OutputSchema = z.object({ ticker: z.string(), filingUrl: z.string().url(), filingType: z.string(), filingDate: z.string(), reportingPeriod: z.string().nullable() });

export class SecFilingTool implements Tool<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> {
  readonly manifest = FilingSearchToolManifest;
  readonly input = InputSchema;
  readonly output = OutputSchema;

  constructor(private readonly client: SecEdgarClient) {}

  async invoke(input: z.infer<typeof InputSchema>, context: ToolContext): Promise<ToolResult<z.infer<typeof OutputSchema>>>
  {
    const ticker = input.query.match(/\b[A-Z]{1,5}\b/)?.[0];
    if (!ticker) return toolFailure("INVALID_INPUT", "filing search requires a US ticker symbol in the query");
    const filing = await this.client.findFiling(ticker, { period: input.period }, context.signal);
    if (!filing) return toolFailure("UNAVAILABLE", input.period ? `no SEC filing matched ${ticker} for requested period ${input.period}` : `no recent SEC filing found for ${ticker}`);
    const text = (await this.client.getFilingText(filing.url, context.signal)).slice(0, MAX_FILING_EVIDENCE_CHARS);
    if (!text) return toolFailure("UNAVAILABLE", "SEC filing contained no extractable text", true);
    const documentContentHash = createHash("sha256").update(text).digest("hex");
    const excerpts = chunkFilingText(text);
    if (!excerpts.length) return toolFailure("UNAVAILABLE", "SEC filing contained no locatable disclosure excerpts", true);
    return {
      ok: true as const,
      value: { ticker: filing.ticker, filingUrl: filing.url, filingType: filing.form, filingDate: filing.filingDate, reportingPeriod: filing.reportDate },
      evidence: excerpts.map((excerpt, index) => ({
        id: randomUUID(), sourceType: "sec_filing", authority: "primary", title: `${filing.companyName} ${filing.form} (${filing.filingDate}) excerpt ${index + 1}/${excerpts.length}`, content: excerpt.content,
        sourceUrl: filing.url,
        locator: `SEC ${filing.form}; accession ${filing.accessionNumber}; primary document ${filing.primaryDocument}; normalized characters ${excerpt.startOffset + 1}-${excerpt.endOffset}`,
        entity: filing.ticker, publishedAt: `${filing.filingDate}T00:00:00.000Z`, asOfDate: filing.reportDate ?? filing.filingDate,
        retrievedAt: new Date().toISOString(), contentHash: createHash("sha256").update(excerpt.content).digest("hex"), license: "SEC EDGAR public filing", tenantId: context.scope.organizationId,
        metadata: {
          cik: filing.cik,
          accessionNumber: filing.accessionNumber,
          filingType: filing.form,
          reportingPeriod: filing.reportDate,
          documentContentHash,
          excerptIndex: index + 1,
          excerptCount: excerpts.length,
          characterStart: excerpt.startOffset + 1,
          characterEnd: excerpt.endOffset,
        },
      } as EvidenceItem)), estimatedCostUsd: 0,
    };
  }
}
