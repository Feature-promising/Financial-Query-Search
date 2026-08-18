export interface SecCompany { ticker: string; cik: string; name: string; }
export interface SecFiling {
  ticker: string; companyName: string; cik: string; accessionNumber: string;
  form: string; filingDate: string; reportDate: string | null; primaryDocument: string; url: string;
}

export interface SecFilingSearchCriteria {
  /** An unambiguous fiscal year or cutoff date propagated from intent analysis. */
  period?: string;
}

type SecRecentFilings = Record<string, Array<string | null | undefined>>;
type SecSubmissions = { filings?: { recent?: SecRecentFilings; files?: Array<{ name?: string }> } };

interface FetchLike { (input: string, init?: RequestInit): Promise<Response>; }

const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 2;
const SEC_HOSTS = new Set(["data.sec.gov", "www.sec.gov"]);

export class SecEdgarClient {
  private tickerIndex?: Map<string, SecCompany>;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: { userAgent: string; fetch?: FetchLike; maxResponseBytes?: number }) {
    const configuredLimit = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > DEFAULT_MAX_RESPONSE_BYTES) {
      throw new Error("SEC response size limit must be a positive integer no larger than 5 MiB");
    }
    this.maxResponseBytes = configuredLimit;
  }

  async findLatestFiling(ticker: string, signal?: AbortSignal): Promise<SecFiling | undefined> {
    return this.findFiling(ticker, {}, signal);
  }

  /**
   * Chooses only a filing that satisfies the user-requested reporting period.
   * It deliberately refuses a year query when EDGAR exposes no matching
   * `reportDate`; silently substituting the latest filing changes the question.
   */
  async findFiling(ticker: string, criteria: SecFilingSearchCriteria, signal?: AbortSignal): Promise<SecFiling | undefined> {
    const company = await this.resolveTicker(ticker, signal);
    if (!company) return undefined;
    const submissions = await this.getJson(`https://data.sec.gov/submissions/CIK${company.cik}.json`, signal) as SecSubmissions;
    const candidates = this.toCandidates(submissions.filings?.recent).filter((filing) => matchesRequestedPeriod(filing, criteria.period));
    if (!candidates.length && criteria.period) candidates.push(...await this.findHistoricalCandidates(submissions, criteria.period, signal));
    const selected = candidates.sort((left, right) => right.filingDate.localeCompare(left.filingDate))[0];
    if (!selected) return undefined;
    const { accession, document, form, filingDate, reportDate } = selected;
    const path = accession.replaceAll("-", "");
    return { ticker: company.ticker, companyName: company.name, cik: company.cik, accessionNumber: accession, form, filingDate, reportDate, primaryDocument: document, url: `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${path}/${document}` };
  }

  async getFilingText(url: string, signal?: AbortSignal): Promise<string> {
    const html = await this.readText(await this.request(url, signal));
    return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  }

  private async resolveTicker(ticker: string, signal?: AbortSignal): Promise<SecCompany | undefined> {
    if (!this.tickerIndex) {
      const raw = await this.getJson("https://www.sec.gov/files/company_tickers.json", signal) as Record<string, { ticker: string; cik_str: number; title: string }>;
      this.tickerIndex = new Map(Object.values(raw).map((item) => [item.ticker.toUpperCase(), { ticker: item.ticker.toUpperCase(), cik: String(item.cik_str).padStart(10, "0"), name: item.title }]));
    }
    return this.tickerIndex.get(ticker.toUpperCase());
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    return JSON.parse(await this.readText(await this.request(url, signal)));
  }

  private toCandidates(recent: SecRecentFilings | undefined): Array<{ form: string; accession: string; document: string; filingDate: string; reportDate: string | null }> {
    if (!recent) return [];
    return (recent.form ?? []).flatMap((form, index) => {
      const accession = recent.accessionNumber?.[index];
      const document = recent.primaryDocument?.[index];
      const filingDate = recent.filingDate?.[index];
      const reportDate = recent.reportDate?.[index] ?? null;
      if (typeof form !== "string" || !["10-K", "10-Q", "8-K"].includes(form) || typeof accession !== "string" || typeof document !== "string" || typeof filingDate !== "string") return [];
      return [{ form, accession, document, filingDate, reportDate: typeof reportDate === "string" ? reportDate : null }];
    });
  }

  private async findHistoricalCandidates(submissions: SecSubmissions, period: string, signal?: AbortSignal): Promise<Array<{ form: string; accession: string; document: string; filingDate: string; reportDate: string | null }>> {
    const names = (submissions.filings?.files ?? []).flatMap((file) => file.name && /^CIK\d{10}-submissions-\d{3}\.json$/.test(file.name) ? [file.name] : []).slice(0, 10);
    const histories = await Promise.all(names.map(async (name) => this.getJson(`https://data.sec.gov/submissions/${name}`, signal) as Promise<SecRecentFilings>));
    return histories.flatMap((history) => this.toCandidates(history).filter((filing) => matchesRequestedPeriod(filing, period)));
  }

  private async request(url: string, signal?: AbortSignal, redirects = 0): Promise<Response> {
    assertAllowlistedSecUrl(url);
    const response = await (this.options.fetch ?? fetch)(url, { signal, redirect: "manual", headers: { "User-Agent": this.options.userAgent, Accept: "application/json,text/html" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects >= MAX_REDIRECTS) throw new Error("SEC request exceeded the allowed redirect policy");
      return this.request(new URL(location, url).toString(), signal, redirects + 1);
    }
    if (!response.ok) throw new Error(`SEC request failed: ${response.status}`);
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && Number(declaredLength) > this.maxResponseBytes) throw new Error("SEC response exceeded the configured size limit");
    return response;
  }

  private async readText(response: Response): Promise<string> {
    const body = response.body;
    if (!body) throw new Error("SEC response has no readable body");
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxResponseBytes) {
          await reader.cancel();
          throw new Error("SEC response exceeded the configured size limit");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  }
}

/** SEC URLs are derived internally; this guard keeps exported client methods SSRF-safe. */
function assertAllowlistedSecUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("SEC request URL is invalid"); }
  if (url.protocol !== "https:" || !SEC_HOSTS.has(url.hostname) || url.port || url.username || url.password) {
    throw new Error("SEC request URL is outside the approved SEC allowlist");
  }
}

function matchesRequestedPeriod(filing: { filingDate: string; reportDate: string | null }, period: string | undefined): boolean {
  if (!period) return true;
  if (/^20\d{2}$/.test(period)) return filing.reportDate?.startsWith(period) === true;
  if (/^20\d{2}-\d{2}-\d{2}$/.test(period)) return filing.filingDate <= period && (filing.reportDate == null || filing.reportDate <= period);
  return false;
}
