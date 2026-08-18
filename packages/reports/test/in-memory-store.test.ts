import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryReportStore } from "../src/index.js";

describe("InMemoryReportStore", () => {
  it("isolates private reports by owner while allowing organization administrators", async () => {
    const store = new InMemoryReportStore();
    const owner = { organizationId: "org-1", userId: "u-1", roles: ["researcher"] as const, entitlements: [] };
    const report = await store.create(owner, { runId: randomUUID(), organizationId: "org-1", ownerUserId: owner.userId, markdown: "# Report", citations: [] });
    expect(await store.get({ organizationId: "org-1", userId: "u-1", roles: ["researcher"], entitlements: [] }, report.id)).toBeDefined();
    expect(await store.get({ organizationId: "org-1", userId: "u-2", roles: ["researcher"], entitlements: [] }, report.id)).toBeUndefined();
    expect(await store.get({ organizationId: "org-1", userId: "admin", roles: ["admin"], entitlements: [] }, report.id)).toBeDefined();
    expect(await store.get({ organizationId: "org-2", userId: "u-2", roles: ["researcher"], entitlements: [] }, report.id)).toBeUndefined();
  });
});
