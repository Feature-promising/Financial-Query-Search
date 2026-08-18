import { AgentToolManifestSnapshotSchema, ToolManifestSchema, type ToolManifest } from "@research/contracts";

/**
 * Parses the administrator-managed, agent-visible tool approval catalog.
 * This value is sourced from deployment secrets, never a browser or model.
 */
export function parseApprovedToolManifestCatalog(raw: string): ToolManifest[] {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("approved tool manifest catalog must be valid JSON");
  }
  return validateApprovedToolManifestCatalog(candidate);
}

/** Validates an already decoded catalog before it can alter a registry. */
export function validateApprovedToolManifestCatalog(candidate: unknown): ToolManifest[] {
  // The run snapshot contract is deliberately reused: an approval catalog may
  // contain only enabled, agent-visible, unique manifests.
  return AgentToolManifestSnapshotSchema.parse(candidate).map((manifest) => ToolManifestSchema.parse(manifest));
}
