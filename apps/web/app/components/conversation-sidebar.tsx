"use client";

import { FormEvent, useState } from "react";
import type { ConversationView } from "../lib/research-types";

export function ConversationSidebar({ active, archived, activeHasMore, archivedHasMore, selectedId, loading, loadingMore, error, onNew, onSelect, onRename, onArchive, onDelete, onLoadMore }: {
  active: ConversationView[];
  archived: ConversationView[];
  activeHasMore: boolean;
  archivedHasMore: boolean;
  selectedId?: string;
  loading: boolean;
  loadingMore?: "active" | "archived";
  error?: string;
  onNew: () => void;
  onSelect: (conversationId: string) => void;
  onRename: (conversationId: string, title: string) => Promise<void>;
  onArchive: (conversationId: string, archived: boolean) => Promise<void>;
  onDelete: (conversationId: string) => Promise<void>;
  onLoadMore: (archived: boolean) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string>();
  const [title, setTitle] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<string>();

  async function rename(event: FormEvent, conversationId: string): Promise<void> {
    event.preventDefault();
    if (!title.trim()) return;
    await onRename(conversationId, title.trim());
    setEditing(undefined); setTitle("");
  }

  return <aside className="conversation-sidebar" aria-label="研究会话">
    <div className="sidebar-heading"><div><strong>研究会话</strong><span>{loading ? "同步中" : `${active.length} 个进行中`}</span></div><button className="new-conversation-button" type="button" onClick={onNew}>新建</button></div>
    {error && <p className="sidebar-error">{error}</p>}
    <ConversationList conversations={active} empty="暂无活动会话" selectedId={selectedId} editing={editing} title={title} confirmingDelete={confirmingDelete} onSelect={onSelect} onStartRename={(item) => { setEditing(item.id); setTitle(item.title); }} onTitleChange={setTitle} onRename={rename} onArchive={onArchive} onConfirmDelete={(id) => setConfirmingDelete((current) => current === id ? undefined : id)} onDelete={async (id) => { await onDelete(id); setConfirmingDelete(undefined); }} />
    {activeHasMore && <button type="button" className="load-more-conversations" disabled={loadingMore === "active"} onClick={() => void onLoadMore(false)}>{loadingMore === "active" ? "正在加载" : "加载更多会话"}</button>}
    <details className="archived-conversations"><summary>已归档 ({archived.length})</summary><ConversationList conversations={archived} empty="没有已归档会话" selectedId={selectedId} editing={editing} title={title} confirmingDelete={confirmingDelete} onSelect={onSelect} onStartRename={(item) => { setEditing(item.id); setTitle(item.title); }} onTitleChange={setTitle} onRename={rename} onArchive={onArchive} onConfirmDelete={(id) => setConfirmingDelete((current) => current === id ? undefined : id)} onDelete={async (id) => { await onDelete(id); setConfirmingDelete(undefined); }} />{archivedHasMore && <button type="button" className="load-more-conversations" disabled={loadingMore === "archived"} onClick={() => void onLoadMore(true)}>{loadingMore === "archived" ? "正在加载" : "加载更多已归档会话"}</button>}</details>
  </aside>;
}

function ConversationList({ conversations, empty, selectedId, editing, title, confirmingDelete, onSelect, onStartRename, onTitleChange, onRename, onArchive, onConfirmDelete, onDelete }: {
  conversations: ConversationView[];
  empty: string;
  selectedId?: string;
  editing?: string;
  title: string;
  confirmingDelete?: string;
  onSelect: (conversationId: string) => void;
  onStartRename: (conversation: ConversationView) => void;
  onTitleChange: (title: string) => void;
  onRename: (event: FormEvent, conversationId: string) => Promise<void>;
  onArchive: (conversationId: string, archived: boolean) => Promise<void>;
  onConfirmDelete: (conversationId: string) => void;
  onDelete: (conversationId: string) => Promise<void>;
}) {
  if (!conversations.length) return <p className="conversation-empty">{empty}</p>;
  return <ul className="conversation-list">{conversations.map((conversation) => <li className={conversation.id === selectedId ? "conversation-row conversation-row--selected" : "conversation-row"} key={conversation.id}>
    {editing === conversation.id ? <form onSubmit={(event) => void onRename(event, conversation.id)} className="conversation-rename"><input aria-label="会话标题" value={title} onChange={(event) => onTitleChange(event.target.value)} maxLength={140} autoFocus /><button type="submit">保存</button></form> : <button className="conversation-select" type="button" onClick={() => onSelect(conversation.id)}><span>{conversation.title}</span><time>{formatDate(conversation.updatedAt)}</time></button>}
    <div className="conversation-actions"><button type="button" onClick={() => onStartRename(conversation)}>重命名</button><button type="button" onClick={() => void onArchive(conversation.id, !conversation.archivedAt)}>{conversation.archivedAt ? "恢复" : "归档"}</button><button type="button" className="danger-action" onClick={() => onConfirmDelete(conversation.id)}>删除</button></div>
    {confirmingDelete === conversation.id && <div className="delete-confirm"><span>仅隐藏会话，研究审计记录将保留。</span><button type="button" className="danger-action" onClick={() => void onDelete(conversation.id)}>确认删除</button></div>}
  </li>)}</ul>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}
