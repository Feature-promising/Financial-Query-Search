import { DescribeStatementCommand, ExecuteStatementCommand, GetStatementResultCommand } from "@aws-sdk/client-redshift-data";
import { describe, expect, it } from "vitest";
import { RedshiftFinancialWarehouse, type RedshiftStatementClient } from "../src/index.js";

describe("RedshiftFinancialWarehouse", () => {
  it("executes a fixed named template through the Data API", async () => {
    const client = new FakeRedshift();
    const warehouse = new RedshiftFinancialWarehouse({ region: "us-east-1", workgroupName: "research", database: "warehouse", secretArn: secretArn(), client, pollIntervalMs: 0 });
    const rows = await warehouse.query("company_fundamentals", { ticker: "NVDA" });
    expect(rows).toEqual([{ ticker: "NVDA", revenue: 100 }]);
    expect(client.executedSql).toContain("financial_company_fundamentals");
    expect(client.executedSql).not.toContain("NVDA");
    expect(client.executedSql).toContain("source_as_of <= CAST(:asOfDate AS date)");
  });

  it("exposes a fixed source-dated valuation input template", async () => {
    const client = new FakeRedshift();
    const warehouse = new RedshiftFinancialWarehouse({ region: "us-east-1", workgroupName: "research", database: "warehouse", secretArn: secretArn(), client, pollIntervalMs: 0 });
    await warehouse.query("valuation_inputs", { ticker: "NVDA" });
    expect(client.executedSql).toContain("financial_valuation_inputs");
    expect(client.executedSql).toContain("source_as_of IS NOT NULL");
    expect(client.executedSql).toContain("source_as_of <= CAST(:asOfDate AS date)");
  });

  it("prevents price-history look-ahead by constraining both trade and source dates", async () => {
    const client = new FakeRedshift();
    const warehouse = new RedshiftFinancialWarehouse({ region: "us-east-1", workgroupName: "research", database: "warehouse", secretArn: secretArn(), client, pollIntervalMs: 0 });
    await warehouse.query("price_history", { ticker: "NVDA", asOfDate: "2025-12-31" });
    expect(client.executedSql).toContain("trade_date <= CAST(:asOfDate AS date)");
    expect(client.executedSql).toContain("source_as_of <= CAST(:asOfDate AS date)");
  });

  it("does not submit an aborted warehouse query", async () => {
    const client = new FakeRedshift();
    const controller = new AbortController();
    controller.abort();
    const warehouse = new RedshiftFinancialWarehouse({ region: "us-east-1", workgroupName: "research", database: "warehouse", secretArn: secretArn(), client, pollIntervalMs: 0 });

    await expect(warehouse.query("company_fundamentals", { ticker: "NVDA" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(client.executedSql).toBe("");
  });
});

class FakeRedshift implements RedshiftStatementClient {
  executedSql = "";
  async send(command: ExecuteStatementCommand | DescribeStatementCommand | GetStatementResultCommand): Promise<Record<string, unknown>> {
    if (command instanceof ExecuteStatementCommand) { this.executedSql = String(command.input.Sql); return { Id: "statement-1" }; }
    if (command instanceof DescribeStatementCommand) return { Status: "FINISHED" };
    return { ColumnMetadata: [{ name: "ticker" }, { name: "revenue" }], Records: [[{ stringValue: "NVDA" }, { longValue: 100 }]] };
  }
}

function secretArn(): string {
  return "arn:aws:secretsmanager:us-east-1:123456789012:secret:research-redshift";
}
