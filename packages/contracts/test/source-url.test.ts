import { describe, expect, it } from "vitest";
import { HttpSourceUrlSchema, ReportCitationSchema } from "../src/index.js";

describe("evidence source URLs", () => {
  it("accepts browser-safe HTTP(S) sources", () => {
    expect(HttpSourceUrlSchema.safeParse("https://www.sec.gov/Archives/example").success).toBe(true);
    expect(HttpSourceUrlSchema.safeParse("http://localhost:3000/source").success).toBe(true);
  });

  it("rejects non-web schemes before they can reach evidence or report links", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "mailto:research@example.com"]) {
      expect(HttpSourceUrlSchema.safeParse(value).success).toBe(false);
    }
    expect(ReportCitationSchema.safeParse({ number: 1, evidenceId: "144d8a8a-cd10-49a9-ab1f-7a0bff2aa8b8", title: "Unsafe", locator: "row 1", sourceUrl: "javascript:alert(1)", asOfDate: null, license: "test" }).success).toBe(false);
  });
});
