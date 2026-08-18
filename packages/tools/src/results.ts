import { ToolFailureSchema, type ToolFailure } from "@research/contracts";
import type { ToolResult } from "./types.js";

export function toolFailure(code: ToolFailure["code"], message: string, retryable = false): ToolResult<never> {
  return { ok: false, failure: ToolFailureSchema.parse({ code, message, retryable }), estimatedCostUsd: 0 };
}
