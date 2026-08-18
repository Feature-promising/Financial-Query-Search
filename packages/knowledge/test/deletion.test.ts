import { describe, expect, it } from "vitest";
import { EvidenceDeletionCoordinator } from "../src/index.js";

describe("EvidenceDeletionCoordinator", () => {
  it("propagates deletion to all evidence stores", async () => {
    const deleted: string[] = [];
    const coordinator = new EvidenceDeletionCoordinator({
      index: { upsert: async () => undefined, search: async () => [], deleteByEvidenceIds: async (_tenant, ids) => { deleted.push(...ids); } },
      graph: { expand: async () => [], deleteEvidenceReferences: async (_tenant, ids) => { deleted.push(...ids); } },
      lake: { put: async () => ({ uri: "", versionId: "" }), get: async () => new Uint8Array(), delete: async (uri) => { deleted.push(uri); } },
    });
    await coordinator.delete({ tenantId: "org-1", evidenceIds: ["e-1"], evidenceUris: ["s3://bucket/e-1"] });
    expect(deleted).toEqual(["e-1", "e-1", "s3://bucket/e-1"]);
  });
});
