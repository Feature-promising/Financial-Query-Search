"use client";

import { FormEvent, useState } from "react";
import { useResearchPreferences } from "../hooks/use-research-preferences";
import type { ConfirmedPreference } from "../lib/research-types";

const valuationMethods: Array<Extract<ConfirmedPreference, { key: "valuation_method" }>["value"]> = ["DCF", "comparable_companies", "precedent_transactions", "blended"];
const displayUnits: Array<Extract<ConfirmedPreference, { key: "display_unit" }>["value"]> = ["USD", "USD thousands", "USD millions", "USD billions", "percentage", "basis points"];

/** UI deliberately exposes only the API's closed, user-confirmed preference contract. */
export function PreferencePanel({ disabled }: { disabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [valuationMethod, setValuationMethod] = useState<typeof valuationMethods[number]>("DCF");
  const [displayUnit, setDisplayUnit] = useState<typeof displayUnits[number]>("USD millions");
  const [industries, setIndustries] = useState("");
  const [comparisonFramework, setComparisonFramework] = useState("");
  const { preferences, loading, saving, error, load, save } = useResearchPreferences();

  async function open(): Promise<void> {
    setExpanded((current) => !current);
    if (!expanded) await load();
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const industryValues = industries.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 20);
    await Promise.all([
      save({ key: "valuation_method", value: valuationMethod }),
      save({ key: "display_unit", value: displayUnit }),
      industryValues.length ? save({ key: "focus_industries", value: industryValues }) : Promise.resolve(),
      comparisonFramework.trim() ? save({ key: "comparison_framework", value: comparisonFramework.trim() }) : Promise.resolve(),
    ]);
  }

  return <section className="preferences">
    <button type="button" className="quiet-button" onClick={() => void open()} disabled={disabled || loading}>
      {expanded ? "收起研究偏好" : "研究偏好"}
    </button>
    {expanded && <form className="preference-form" onSubmit={submit}>
      <p>仅保存您明确确认的分析与展示默认值；它们不是金融事实或引用。</p>
      <label>默认估值方法<select value={valuationMethod} onChange={(event) => setValuationMethod(event.target.value as typeof valuationMethod)}>{valuationMethods.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
      <label>默认展示单位<select value={displayUnit} onChange={(event) => setDisplayUnit(event.target.value as typeof displayUnit)}>{displayUnits.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
      <label>关注行业（逗号分隔）<input value={industries} onChange={(event) => setIndustries(event.target.value)} maxLength={1_600} placeholder="Semiconductors, Cloud" /></label>
      <label>比较框架<input value={comparisonFramework} onChange={(event) => setComparisonFramework(event.target.value)} maxLength={160} placeholder="growth-margin-moat" /></label>
      <button disabled={saving || disabled}>{saving ? "保存中…" : "保存已确认偏好"}</button>
      {error && <p className="error">{error}</p>}
      {preferences.length > 0 && <p className="metadata">当前已保存：{preferences.map(describePreference).join(" · ")}</p>}
    </form>}
  </section>;
}

function describePreference(preference: ConfirmedPreference): string {
  return preference.key === "focus_industries" ? preference.value.join(", ") : String(preference.value);
}
