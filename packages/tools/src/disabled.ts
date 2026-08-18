import { z } from "zod";
import type { Tool } from "./types.js";
import { toolFailure } from "./results.js";

const DisabledInputSchema = z.object({ query: z.string().min(1).max(4_000) });
const DisabledOutputSchema = z.object({ status: z.literal("unavailable") });

export function disabledResearchTool(id: string, capability: string): Tool<z.infer<typeof DisabledInputSchema>, z.infer<typeof DisabledOutputSchema>> {
  return {
    manifest: { id, version: "1", capability, requiredEntitlements: [], timeoutMs: 20_000, enabled: true },
    input: DisabledInputSchema,
    output: DisabledOutputSchema,
    async invoke() { return toolFailure("UNAVAILABLE", `${id} has no configured production provider`); },
  };
}
