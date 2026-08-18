import { describe, expect, it } from "vitest";
import { RunCostLedger } from "../src/index.js";

describe("RunCostLedger", () => {
  it("accounts for reservations before allowing further billable work", () => {
    const ledger = new RunCostLedger(1);
    const reservation = ledger.reserve(0.8);
    expect(reservation).toBe(0.8);
    expect(ledger.reserve(0.3)).toBeUndefined();
    expect(ledger.settle(reservation!, 0.5)).toBe(true);
    expect(ledger.available).toBeCloseTo(0.5);
    expect(ledger.spend(0.6)).toBe(false);
    expect(ledger.exhausted).toBe(true);
  });
});
