"use client";

import { useState } from "react";
import { getAccessTokenOrRedirect, oidcEnabled } from "../auth/oidc-session";
import { createResearchApiClient } from "../lib/research-api";
import type { ConfirmedPreference } from "../lib/research-types";

/** Owns browser authentication and safe state transitions for preference APIs. */
export function useResearchPreferences() {
  const [preferences, setPreferences] = useState<ConfirmedPreference[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function api() {
    const accessToken = await getAccessTokenOrRedirect(window.location.pathname);
    if (!accessToken && oidcEnabled()) return undefined;
    return createResearchApiClient(accessToken);
  }

  async function load(): Promise<void> {
    setLoading(true); setError(undefined);
    try {
      const client = await api();
      if (!client) return;
      setPreferences(await client.listPreferences());
    } catch {
      setError("无法读取已确认的研究偏好。");
    } finally { setLoading(false); }
  }

  async function save(preference: ConfirmedPreference): Promise<void> {
    setSaving(true); setError(undefined);
    try {
      const client = await api();
      if (!client) return;
      const saved = await client.savePreference(preference);
      setPreferences((current) => [...current.filter((item) => item.key !== saved.key), saved]);
    } catch {
      setError("无法保存研究偏好。");
    } finally { setSaving(false); }
  }

  return { preferences, loading, saving, error, load, save };
}
