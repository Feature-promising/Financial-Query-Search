import json
import sqlite3
from pathlib import Path
from typing import Any


DB_PATH = Path(__file__).with_name("chat_history.db")


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                sources_json TEXT NOT NULL DEFAULT '[]',
                meta TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id)
            )
            """
        )


def ensure_session(session_id: str, title: str) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO sessions (session_id, title)
            VALUES (?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                title = COALESCE(NULLIF(sessions.title, ''), excluded.title),
                updated_at = CURRENT_TIMESTAMP
            """,
            (session_id, title),
        )


def touch_session(session_id: str) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            UPDATE sessions
            SET updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
            """,
            (session_id,),
        )


def save_message(
    session_id: str,
    role: str,
    content: str,
    sources: list[dict[str, Any]] | None = None,
    meta: str = "",
) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO messages (session_id, role, content, sources_json, meta)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                session_id,
                role,
                content,
                json.dumps(sources or [], ensure_ascii=False),
                meta,
            ),
        )
        conn.execute(
            """
            UPDATE sessions
            SET updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
            """,
            (session_id,),
        )


def list_sessions(limit: int = 20) -> list[dict[str, str]]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT session_id, title, updated_at
            FROM sessions
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return [
        {
            "session_id": str(row["session_id"]),
            "title": str(row["title"]),
            "updated_at": str(row["updated_at"]),
        }
        for row in rows
    ]


def load_messages(session_id: str) -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT role, content, sources_json, meta
            FROM messages
            WHERE session_id = ?
            ORDER BY id ASC
            """,
            (session_id,),
        ).fetchall()

    messages: list[dict[str, Any]] = []
    for row in rows:
        messages.append(
            {
                "role": str(row["role"]),
                "content": str(row["content"]),
                "sources": json.loads(row["sources_json"] or "[]"),
                "meta": str(row["meta"] or ""),
            }
        )
    return messages


def delete_session(session_id: str) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            DELETE FROM messages
            WHERE session_id = ?
            """,
            (session_id,),
        )
        conn.execute(
            """
            DELETE FROM sessions
            WHERE session_id = ?
            """,
            (session_id,),
        )
