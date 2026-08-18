"use client";

import { useCallback, useRef, useState } from "react";
import { getAccessTokenOrRedirect, oidcEnabled } from "../auth/oidc-session";
import { createResearchApiClient } from "../lib/research-api";
import type { ConversationView } from "../lib/research-types";

/** Owns only visible conversation lifecycle state; research runs remain separate, immutable records. */
export function useConversations() {
  const [active, setActive] = useState<ConversationView[]>([]);
  const [archived, setArchived] = useState<ConversationView[]>([]);
  const [activeNextCursor, setActiveNextCursor] = useState<string | null>(null);
  const [archivedNextCursor, setArchivedNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState<"active" | "archived">();
  const [error, setError] = useState<string>();
  const apiRef = useRef<ReturnType<typeof createResearchApiClient> | undefined>(undefined);

  const api = useCallback(async () => {
    if (apiRef.current) return apiRef.current;
    const accessToken = await getAccessTokenOrRedirect(window.location.pathname);
    if (!accessToken && oidcEnabled()) return undefined;
    const client = createResearchApiClient(accessToken);
    apiRef.current = client;
    return client;
  }, []);

  const refresh = useCallback(async () => {
    const client = await api();
    if (!client) return;
    setLoading(true); setError(undefined);
    try {
      const [nextActive, nextArchived] = await Promise.all([client.listConversations(), client.listConversations({ archived: true })]);
      setActive(nextActive.conversations); setArchived(nextArchived.conversations);
      setActiveNextCursor(nextActive.nextCursor); setArchivedNextCursor(nextArchived.nextCursor);
    } catch { setError("会话列表暂不可用。"); }
    finally { setLoading(false); }
  }, [api]);

  const rename = useCallback(async (conversationId: string, title: string) => {
    try {
      const client = await api(); if (!client) return;
      await client.renameConversation(conversationId, title);
      await refresh();
    } catch { setError("会话重命名失败，请稍后重试。"); }
  }, [api, refresh]);

  const archive = useCallback(async (conversationId: string, shouldArchive: boolean) => {
    try {
      const client = await api(); if (!client) return;
      await client.archiveConversation(conversationId, shouldArchive);
      await refresh();
    } catch { setError("会话状态更新失败，请稍后重试。"); }
  }, [api, refresh]);

  const remove = useCallback(async (conversationId: string) => {
    try {
      const client = await api(); if (!client) return;
      await client.deleteConversation(conversationId);
      await refresh();
    } catch { setError("会话删除失败，请稍后重试。"); }
  }, [api, refresh]);

  const loadMore = useCallback(async (archivedPage: boolean) => {
    const cursor = archivedPage ? archivedNextCursor : activeNextCursor;
    if (!cursor || loadingMore) return;
    const client = await api(); if (!client) return;
    const type = archivedPage ? "archived" : "active";
    setLoadingMore(type); setError(undefined);
    try {
      const page = await client.listConversations({ archived: archivedPage, cursor });
      if (archivedPage) {
        setArchived((previous) => mergeConversations(previous, page.conversations));
        setArchivedNextCursor(page.nextCursor);
      } else {
        setActive((previous) => mergeConversations(previous, page.conversations));
        setActiveNextCursor(page.nextCursor);
      }
    } catch { setError("更多会话暂不可用，请稍后重试。"); }
    finally { setLoadingMore(undefined); }
  }, [activeNextCursor, api, archivedNextCursor, loadingMore]);

  return { active, archived, activeHasMore: Boolean(activeNextCursor), archivedHasMore: Boolean(archivedNextCursor), loading, loadingMore, error, refresh, rename, archive, remove, loadMore };
}

function mergeConversations(existing: ConversationView[], additional: ConversationView[]): ConversationView[] {
  const ids = new Set(existing.map((conversation) => conversation.id));
  return [...existing, ...additional.filter((conversation) => !ids.has(conversation.id))];
}
