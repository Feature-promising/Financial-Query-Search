import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@aws-sdk/protocol-http";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import type { OpenSearchBulkResponse, OpenSearchTransport } from "./opensearch-vector-index.js";

export interface FetchLike { (input: string, init?: RequestInit): Promise<Response>; }

/** SigV4 transport for Amazon OpenSearch Service. It accepts no static credentials. */
export class AwsOpenSearchTransport implements OpenSearchTransport {
  private readonly endpoint: URL;
  private readonly signer: SignatureV4;
  private readonly fetcher: FetchLike;

  constructor(options: { endpoint: string; region: string; fetcher?: FetchLike }) {
    this.endpoint = new URL(options.endpoint);
    if (this.endpoint.protocol !== "https:") throw new Error("OpenSearch endpoint must use HTTPS");
    this.signer = new SignatureV4({ credentials: defaultProvider(), region: options.region, service: "es", sha256: Sha256 });
    this.fetcher = options.fetcher ?? fetch;
  }

  async bulk(request: { operations: unknown[] }): Promise<OpenSearchBulkResponse> {
    const body = request.operations.map((operation) => JSON.stringify(operation)).join("\n") + "\n";
    return this.send("POST", "/_bulk", body, "application/x-ndjson");
  }

  async search(request: { index: string; body: Record<string, unknown> }): Promise<{ hits?: { hits?: Array<{ _source?: unknown }> } }> {
    return this.send("POST", `/${encodeURIComponent(request.index)}/_search`, JSON.stringify(request.body));
  }

  async deleteByQuery(request: { index: string; body: Record<string, unknown> }): Promise<unknown> {
    return this.send("POST", `/${encodeURIComponent(request.index)}/_delete_by_query`, JSON.stringify(request.body));
  }

  private async send<T>(method: "POST", path: string, body: string, contentType = "application/json"): Promise<T> {
    const signed = await this.signer.sign(new HttpRequest({ protocol: this.endpoint.protocol, hostname: this.endpoint.hostname, port: this.endpoint.port ? Number(this.endpoint.port) : undefined, method, path: `${this.endpoint.pathname.replace(/\/$/, "")}${path}`, headers: { host: this.endpoint.host, "content-type": contentType }, body }));
    const response = await this.fetcher(`${this.endpoint.origin}${signed.path}`, { method, headers: signed.headers, body });
    const text = await response.text();
    if (!response.ok) throw new Error(`OpenSearch request failed (${response.status}): ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) as T : {} as T;
  }
}
