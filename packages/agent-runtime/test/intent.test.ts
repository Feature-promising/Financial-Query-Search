import { describe, expect, it } from "vitest";
import { extractRequestedPeriod, RuleBasedIntentAnalyzer } from "../src/index.js";

describe("requested-period extraction", () => {
  it("extracts explicit ISO dates and years without inventing a period", async () => {
    expect(extractRequestedPeriod("Analyze NVDA as of 2025-12-31")).toBe("2025-12-31");
    expect((await new RuleBasedIntentAnalyzer().analyze("Analyze NVDA fiscal 2025"))).toMatchObject({ period: "2025" });
    expect(extractRequestedPeriod("Analyze NVDA investment value")).toBeNull();
  });
});
