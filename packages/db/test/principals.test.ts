import { describe, expect, it } from "vitest";
import { PostgresPrincipalProvisioner } from "../src/index.js";

describe("PostgresPrincipalProvisioner", () => {
  it("upserts the organization then resolves an opaque OIDC subject to its internal UUID", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const provisioner = new PostgresPrincipalProvisioner({ query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: calls.length === 2 ? [{ id: "f8f3c9ec-546b-4c4f-9eb5-e7cd2d00ee80" }] : [], rowCount: 1 };
    } });
    const scope = await provisioner.resolve({ organizationId: "9d598cc3-ec7c-4472-8a60-8cc9bdc95c0a", userId: "oidc|analyst-123", email: "analyst@example.com", roles: ["researcher"], entitlements: [] });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain("INSERT INTO organizations");
    expect(calls[1]?.sql).toContain("INSERT INTO users");
    expect(calls[1]?.values).toEqual(["9d598cc3-ec7c-4472-8a60-8cc9bdc95c0a", "oidc|analyst-123", "analyst@example.com"]);
    expect(scope.userId).toBe("f8f3c9ec-546b-4c4f-9eb5-e7cd2d00ee80");
  });

  it("requires an email claim", async () => {
    const provisioner = new PostgresPrincipalProvisioner({ query: async () => ({ rows: [], rowCount: 1 }) });
    await expect(provisioner.resolve({ organizationId: "org", userId: "user", roles: ["researcher"], entitlements: [] })).rejects.toThrow("email claim");
  });
});
