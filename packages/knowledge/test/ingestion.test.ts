import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EvidenceIngestionService } from "../src/index.js";

describe("EvidenceIngestionService", () => {
  it("stores immutable content before indexing enriched provenance", async () => {
    const actions: string[] = [];
    const service = new EvidenceIngestionService(
      { put: async () => { actions.push("lake"); return { uri: "s3://bucket/evidence/org-1/hash.txt", versionId: "v1" }; }, get: async () => new Uint8Array(), delete: async () => undefined },
      { upsert: async (items) => { actions.push(`index:${String(items[0]?.metadata.evidenceUri)}`); }, search: async () => [], deleteByEvidenceIds: async () => undefined },
    );
    const output = await service.store([{ id: randomUUID(), sourceType: "sec_filing", authority: "primary", title: "10-K", content: "evidence", sourceUrl: null, locator: "p.1", entity: "NVDA", publishedAt: null, asOfDate: null, retrievedAt: "2026-08-14T08:00:00.000Z", contentHash: "a".repeat(64), license: "SEC", tenantId: "org-1", metadata: {} }]);
    expect(actions).toEqual(["lake", "index:s3://bucket/evidence/org-1/hash.txt"]);
    expect(output[0]?.metadata.evidenceVersionId).toBe("v1");
  });

  it("writes only evidence-bound graph relations after immutable content and retrieval indexing", async () => {
    const actions: string[] = [];
    const graphRelations: unknown[] = [];
    const service = new EvidenceIngestionService(
      { put: async () => { actions.push("lake"); return { uri: "s3://bucket/evidence/org-1/hash.txt", versionId: "v1" }; }, get: async () => new Uint8Array(), delete: async () => undefined },
      { upsert: async () => { actions.push("index"); }, search: async () => [], deleteByEvidenceIds: async () => undefined },
      { upsertEvidenceRelations: async (_tenant, relations) => { actions.push("graph"); graphRelations.push(...relations); } },
    );
    const evidenceId = randomUUID();
    await service.store([{ id: evidenceId, sourceType: "sec_filing", authority: "primary", title: "10-K", content: "evidence", sourceUrl: null, locator: "p.1", entity: "NVDA", publishedAt: null, asOfDate: null, retrievedAt: "2026-08-14T08:00:00.000Z", contentHash: "a".repeat(64), license: "SEC", tenantId: "org-1", graphRelations: [{ subject: "NVDA", predicate: "ISSUED_BY", object: "NVIDIA Corporation" }], metadata: {} }]);

    expect(actions).toEqual(["lake", "index", "graph"]);
    expect(graphRelations).toEqual([{ subject: "NVDA", predicate: "ISSUED_BY", object: "NVIDIA Corporation", evidenceId, requiredEntitlements: [] }]);
  });

  it("rejects lead-only or unlicensed evidence before writing to the evidence lake", async () => {
    let lakeWrites = 0;
    const service = new EvidenceIngestionService(
      { put: async () => { lakeWrites += 1; return { uri: "s3://bucket/evidence/org-1/hash.txt", versionId: "v1" }; }, get: async () => new Uint8Array(), delete: async () => undefined },
      { upsert: async () => undefined, search: async () => [], deleteByEvidenceIds: async () => undefined },
    );
    const base = { id: randomUUID(), sourceType: "sec_filing" as const, authority: "primary" as const, title: "10-K", content: "evidence", sourceUrl: null, locator: "p.1", entity: "NVDA", publishedAt: null, asOfDate: null, retrievedAt: "2026-08-14T08:00:00.000Z", contentHash: "a".repeat(64), license: "SEC", tenantId: "org-1", metadata: {} };

    await expect(service.store([{ ...base, sourceType: "research_memory" }])).rejects.toThrow("must not be ingested");
    await expect(service.store([{ ...base, id: randomUUID(), sourceType: "market_data", authority: "licensed", license: "vendor" }])).rejects.toThrow("must declare required entitlements");
    expect(lakeWrites).toBe(0);
  });

  it("deletes a newly written lake object when indexing fails", async () => {
    const actions: string[] = [];
    const service = new EvidenceIngestionService(
      { put: async () => { actions.push("lake-put"); return { uri: "s3://bucket/evidence/org-1/hash.txt", versionId: "v1" }; }, get: async () => new Uint8Array(), delete: async () => { actions.push("lake-delete"); } },
      { upsert: async () => { actions.push("index"); throw new Error("OpenSearch unavailable"); }, search: async () => [], deleteByEvidenceIds: async () => { actions.push("index-delete"); } },
    );
    const item = { id: randomUUID(), sourceType: "sec_filing" as const, authority: "primary" as const, title: "10-K", content: "evidence", sourceUrl: null, locator: "p.1", entity: "NVDA", publishedAt: null, asOfDate: null, retrievedAt: "2026-08-14T08:00:00.000Z", contentHash: "a".repeat(64), license: "SEC", tenantId: "org-1", metadata: {} };

    await expect(service.store([item])).rejects.toThrow("OpenSearch unavailable");
    expect(actions).toEqual(["lake-put", "index", "index-delete", "lake-delete"]);
  });

  it("retains indexed source evidence when only the derived graph write fails", async () => {
    const actions: string[] = [];
    const service = new EvidenceIngestionService(
      { put: async () => { actions.push("lake-put"); return { uri: "s3://bucket/evidence/org-1/hash.txt", versionId: "v1" }; }, get: async () => new Uint8Array(), delete: async () => { actions.push("lake-delete"); } },
      { upsert: async () => { actions.push("index"); }, search: async () => [], deleteByEvidenceIds: async () => undefined },
      { upsertEvidenceRelations: async () => { actions.push("graph"); throw new Error("Neo4j unavailable"); } },
    );
    const item = { id: randomUUID(), sourceType: "sec_filing" as const, authority: "primary" as const, title: "10-K", content: "evidence", sourceUrl: null, locator: "p.1", entity: "NVDA", publishedAt: null, asOfDate: null, retrievedAt: "2026-08-14T08:00:00.000Z", contentHash: "a".repeat(64), license: "SEC", tenantId: "org-1", graphRelations: [{ subject: "NVDA", predicate: "ISSUED_BY", object: "NVIDIA" }], metadata: {} };

    await expect(service.store([item])).rejects.toThrow("Neo4j unavailable");
    expect(actions).toEqual(["lake-put", "index", "graph"]);
  });

  it("attempts every compensation action and preserves both failures for operators", async () => {
    const actions: string[] = [];
    const service = new EvidenceIngestionService(
      { put: async () => { actions.push("lake-put"); return { uri: "s3://bucket/evidence/org-1/hash.txt", versionId: "v1" }; }, get: async () => new Uint8Array(), delete: async () => { actions.push("lake-delete"); throw new Error("S3 delete unavailable"); } },
      { upsert: async () => { actions.push("index"); throw new Error("OpenSearch unavailable"); }, search: async () => [], deleteByEvidenceIds: async () => { actions.push("index-delete"); throw new Error("OpenSearch delete unavailable"); } },
    );
    const item = { id: randomUUID(), sourceType: "sec_filing" as const, authority: "primary" as const, title: "10-K", content: "evidence", sourceUrl: null, locator: "p.1", entity: "NVDA", publishedAt: null, asOfDate: null, retrievedAt: "2026-08-14T08:00:00.000Z", contentHash: "a".repeat(64), license: "SEC", tenantId: "org-1", metadata: {} };

    await expect(service.store([item])).rejects.toBeInstanceOf(AggregateError);
    expect(actions).toEqual(["lake-put", "index", "index-delete", "lake-delete"]);
  });
});
