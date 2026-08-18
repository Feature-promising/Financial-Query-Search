import { DescribeStatementCommand, ExecuteStatementCommand, GetStatementResultCommand, RedshiftDataClient } from "@aws-sdk/client-redshift-data";
import type { FinancialWarehouse, FinancialWarehouseTemplate } from "../types.js";

export interface RedshiftStatementClient {
  send(command: ExecuteStatementCommand | DescribeStatementCommand | GetStatementResultCommand, options?: { abortSignal?: AbortSignal }): Promise<Record<string, unknown>>;
}

/** Redshift Data API adapter with static parameterized templates; no LLM SQL reaches Redshift. */
export class RedshiftFinancialWarehouse implements FinancialWarehouse {
  private readonly client: RedshiftStatementClient;

  constructor(private readonly options: { region: string; workgroupName: string; database: string; secretArn: string; client?: RedshiftStatementClient; pollIntervalMs?: number }) {
    this.client = options.client ?? new RedshiftDataClient({ region: options.region });
  }

  async query(templateId: FinancialWarehouseTemplate, parameters: Record<string, string | number>, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    throwIfAborted(signal);
    const sql = template(templateId);
    const sourceBoundParameters = { asOfDate: "9999-12-31", ...parameters };
    const statement = await this.client.send(new ExecuteStatementCommand({
      WorkgroupName: this.options.workgroupName, Database: this.options.database, SecretArn: this.options.secretArn,
      Sql: sql, Parameters: Object.entries(sourceBoundParameters).map(([name, value]) => ({ name, value: String(value) })),
    }), { abortSignal: signal }) as { Id?: string };
    if (!statement.Id) throw new Error("Redshift did not return a statement id");
    await this.waitForCompletion(statement.Id, signal);
    const result = await this.client.send(new GetStatementResultCommand({ Id: statement.Id }), { abortSignal: signal }) as { ColumnMetadata?: Array<{ name?: string }>; Records?: Array<Array<Record<string, unknown>>> };
    const columns = (result.ColumnMetadata ?? []).map((column, index) => column.name ?? `column_${index + 1}`);
    return (result.Records ?? []).map((record) => Object.fromEntries(record.map((cell, index) => [columns[index]!, scalar(cell)])));
  }

  private async waitForCompletion(id: string, signal?: AbortSignal): Promise<void> {
    for (let attempts = 0; attempts < 60; attempts += 1) {
      throwIfAborted(signal);
      const result = await this.client.send(new DescribeStatementCommand({ Id: id }), { abortSignal: signal }) as { Status?: string; Error?: string };
      if (result.Status === "FINISHED") return;
      if (["FAILED", "ABORTED"].includes(result.Status ?? "")) throw new Error(`Redshift statement failed: ${result.Error ?? result.Status}`);
      await abortableDelay(this.options.pollIntervalMs ?? 500, signal);
    }
    throw new Error("Redshift statement timed out");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("operation aborted", "AbortError");
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(handle); reject(new DOMException("operation aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function template(id: FinancialWarehouseTemplate): string {
  switch (id) {
    case "company_fundamentals": return "SELECT ticker, fiscal_period, revenue, gross_margin, operating_margin, free_cash_flow, currency, unit, source_as_of FROM financial_company_fundamentals WHERE ticker = :ticker AND source_as_of <= CAST(:asOfDate AS date) ORDER BY fiscal_period DESC LIMIT 20";
    case "price_history": return "SELECT ticker, trade_date, close_price, adjusted_close, volume, currency, unit, source_as_of FROM market_price_history WHERE ticker = :ticker AND trade_date <= CAST(:asOfDate AS date) AND source_as_of <= CAST(:asOfDate AS date) ORDER BY trade_date DESC LIMIT 252";
    case "industry_benchmark": return "SELECT ticker, industry, metric_name, metric_value, fiscal_period, currency, unit, source_as_of FROM industry_benchmarks WHERE ticker = :ticker AND source_as_of <= CAST(:asOfDate AS date) ORDER BY fiscal_period DESC LIMIT 100";
    /**
     * Only this approved view may supply DCF assumptions. It must be maintained
     * from licensed, versioned data with source_as_of populated for every row.
     */
    case "valuation_inputs": return "SELECT ticker, fiscal_period, free_cash_flow, fcf_growth_rate, terminal_growth_rate, discount_rate, projection_years, currency, unit, source_as_of FROM financial_valuation_inputs WHERE ticker = :ticker AND source_as_of IS NOT NULL AND source_as_of <= CAST(:asOfDate AS date) ORDER BY source_as_of DESC LIMIT 1";
  }
}

function scalar(cell: Record<string, unknown>): unknown {
  return cell.stringValue ?? cell.longValue ?? cell.doubleValue ?? cell.booleanValue ?? cell.blobValue ?? null;
}
