import { describe, expect, it } from "vitest";
import { Neo4jKnowledgeGraph } from "../src/index.js";

describe("Neo4jKnowledgeGraph", () => {
  it("uses a fixed source-bound write shape and returns the stored predicate", async () => {
    const client = new RecordingClient();
    const graph = new Neo4jKnowledgeGraph(client);

    const evidenceId = "4d9a706e-5d80-4e9d-9a6b-0123456789ab";
    await graph.upsertEvidenceRelations("org-1", [{ subject: "NVDA", predicate: "ISSUED_BY", object: "NVIDIA", evidenceId, requiredEntitlements: ["market-data"] }]);
    const relations = await graph.expand("org-1", "NVDA", ["market-data"], 10);

    expect(client.calls[0]?.statement).toContain("MERGE (subject)-[relation:RELATION");
    expect(client.calls[0]?.parameters).toEqual({ tenantId: "org-1", relations: [{ subject: "NVDA", predicate: "ISSUED_BY", object: "NVIDIA", evidenceId, requiredEntitlements: ["market-data"] }] });
    expect(client.calls[1]?.statement).toContain("requiredEntitlementCount");
    expect(client.calls[1]?.statement).toContain("relation.evidenceId =~ $evidenceIdPattern");
    expect(client.calls[1]?.parameters).toMatchObject({ allowedEntitlements: ["market-data"], evidenceIdPattern: expect.any(String) });
    expect(relations).toEqual([{ subject: "NVDA", predicate: "ISSUED_BY", object: "NVIDIA", evidenceIds: ["4d9a706e-5d80-4e9d-9a6b-0123456789ab"] }]);
  });

  it("rejects a graph write without a contract-valid evidence ID", async () => {
    const graph = new Neo4jKnowledgeGraph(new RecordingClient());
    await expect(graph.upsertEvidenceRelations("org-1", [{ subject: "NVDA", predicate: "ISSUED_BY", object: "NVIDIA", evidenceId: "untrusted", requiredEntitlements: [] }])).rejects.toThrow("valid evidence UUID");
  });

  it("removes empty relationships after deleting their final evidence reference", async () => {
    const client = new RecordingClient();
    const graph = new Neo4jKnowledgeGraph(client);

    await graph.deleteEvidenceReferences("org-1", ["evidence-1"]);

    expect(client.calls).toHaveLength(3);
    expect(client.calls[0]?.statement).toContain("relation.evidenceId IN $evidenceIds");
    expect(client.calls[2]?.statement).toContain("size(coalesce(relation.evidenceIds, [])) = 0");
  });
});

class RecordingClient {
  readonly calls: Array<{ statement: string; parameters: Record<string, unknown> }> = [];
  async query(statement: string, parameters: Record<string, unknown>) {
    this.calls.push({ statement, parameters });
    if (statement.includes("RETURN subject.canonicalName")) return [{ subject: "NVDA", predicate: "ISSUED_BY", object: "NVIDIA", evidenceIds: ["4d9a706e-5d80-4e9d-9a6b-0123456789ab"] }];
    return [];
  }
}
