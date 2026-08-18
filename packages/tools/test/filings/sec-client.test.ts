import { describe, expect, it } from "vitest";
import { SecEdgarClient } from "../../src/index.js";

describe("SecEdgarClient network boundary", () => {
  it("rejects a non-SEC URL before issuing a request", async () => {
    let calls = 0;
    const client = new SecEdgarClient({ userAgent: "Research Agent test@example.com", fetch: async () => { calls += 1; return new Response("unexpected"); } });

    await expect(client.getFilingText("https://metadata.internal.example/credentials")).rejects.toThrow("approved SEC allowlist");
    expect(calls).toBe(0);
  });

  it("rejects redirects leaving the SEC allowlist", async () => {
    const client = new SecEdgarClient({
      userAgent: "Research Agent test@example.com",
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://metadata.internal.example/latest" } }),
    });

    await expect(client.getFilingText("https://www.sec.gov/Archives/edgar/data/1/a.htm")).rejects.toThrow("approved SEC allowlist");
  });

  it("stops reading an oversized filing response", async () => {
    const client = new SecEdgarClient({
      userAgent: "Research Agent test@example.com",
      maxResponseBytes: 10,
      fetch: async () => new Response("01234567890", { status: 200 }),
    });

    await expect(client.getFilingText("https://www.sec.gov/Archives/edgar/data/1/a.htm")).rejects.toThrow("size limit");
  });
});
