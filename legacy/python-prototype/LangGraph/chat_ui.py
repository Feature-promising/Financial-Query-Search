import asyncio
import time
import uuid

import streamlit as st

from chat_store import delete_session, ensure_session, init_db, list_sessions, load_messages, save_message
from Tools_using import stream_search_assistant


st.set_page_config(
    page_title="Financial Query Assistant",
    page_icon="💬",
    layout="wide",
)

st.markdown(
    """
    <style>
    .app-hero {
        max-width: 52rem;
        padding: 0.6rem 0 1.1rem 0;
    }

    .app-eyebrow {
        color: #6b7280;
        font-size: 0.8rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        margin-bottom: 0.4rem;
    }

    .app-title {
        color: #111827;
        font-size: 2rem;
        font-weight: 700;
        line-height: 1.2;
        margin-bottom: 0.45rem;
    }

    .app-subtitle {
        color: #4b5563;
        font-size: 1rem;
        line-height: 1.7;
        max-width: 42rem;
    }

    .stChatMessage {
        max-width: 52rem;
        margin-bottom: 0.9rem;
    }

    .stChatMessage [data-testid="stMarkdownContainer"] p {
        line-height: 1.65;
        font-size: 0.98rem;
    }

    .stChatMessage[data-testid="stChatMessage-user"] {
        margin-left: auto;
    }

    .stChatMessage[data-testid="stChatMessage-user"] > div {
        background: #eef2ff;
        border: 1px solid #dbe4ff;
        border-radius: 18px;
        padding: 0.2rem 0.35rem;
    }

    .stChatMessage[data-testid="stChatMessage-assistant"] > div {
        background: #ffffff;
        border: 1px solid #e8ebf0;
        border-radius: 18px;
        padding: 0.2rem 0.35rem;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.04);
    }
    </style>
    """,
    unsafe_allow_html=True,
)


def _init_state() -> None:
    init_db()
    if "session_id" not in st.session_state:
        st.session_state.session_id = f"chat-{uuid.uuid4().hex[:8]}"
    if "messages" not in st.session_state:
        st.session_state.messages = []
    if "delete_menu_session_id" not in st.session_state:
        st.session_state.delete_menu_session_id = None


def _new_session() -> None:
    st.session_state.session_id = f"chat-{uuid.uuid4().hex[:8]}"
    st.session_state.messages = []
    st.session_state.delete_menu_session_id = None


def _render_sidebar() -> None:
    with st.sidebar:
        st.title("金融问答助手")
        st.caption("Financial Q&A Assistant")
        st.code(f"session_id: {st.session_state.session_id}")
        if st.button("新建会话", use_container_width=True):
            _new_session()
            st.rerun()

        st.markdown("### 历史会话")
        sessions = list_sessions()
        if not sessions:
            st.caption("暂无历史会话")
            return

        for session in sessions:
            label = session["title"][:24] if session["title"] else session["session_id"]
            col_main, col_action = st.columns([6, 1])

            with col_main:
                if st.button(label, key=f"session-{session['session_id']}", use_container_width=True):
                    st.session_state.session_id = session["session_id"]
                    st.session_state.messages = load_messages(session["session_id"])
                    st.session_state.delete_menu_session_id = None
                    st.rerun()

            with col_action:
                if st.button("...", key=f"session-menu-{session['session_id']}", use_container_width=True):
                    current = st.session_state.delete_menu_session_id
                    st.session_state.delete_menu_session_id = (
                        None if current == session["session_id"] else session["session_id"]
                    )
                    st.rerun()

            if st.session_state.delete_menu_session_id == session["session_id"]:
                if st.button("Delete", key=f"session-delete-{session['session_id']}", use_container_width=True):
                    delete_session(session["session_id"])
                    if st.session_state.session_id == session["session_id"]:
                        _new_session()
                    else:
                        st.session_state.delete_menu_session_id = None
                    st.rerun()


def _render_message(message: dict) -> None:
    with st.chat_message(message["role"]):
        st.markdown(message["content"])

        if message["role"] != "assistant":
            return

        if message.get("sources"):
            with st.expander("查看来源", expanded=False):
                for idx, source in enumerate(message["sources"], start=1):
                    title = source.get("title") or f"来源 {idx}"
                    url = source.get("url") or ""
                    content = source.get("content") or ""
                    st.markdown(f"**{idx}. {title}**")
                    if url:
                        st.markdown(url)
                    if content:
                        st.write(content)

        if message.get("meta"):
            st.caption(message["meta"])


def _stream_answer_text(text: str):
    for char in text:
        yield char
        time.sleep(0.01)


def main() -> None:
    _init_state()
    _render_sidebar()

    st.markdown(
        """
        <div class="app-hero">
            <div class="app-eyebrow">Financial Research Assistant</div>
            <div class="app-title">金融问答助手</div>
            <div class="app-subtitle">
                面向金融信息检索与问答的对话界面。你可以直接提问公司、行业、市场或事件，
                助手会基于现有工作流生成回答。
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    for message in st.session_state.messages:
        _render_message(message)

    user_input = st.chat_input("请输入你的问题，例如：特斯拉最近财报释放了什么信号？")
    if not user_input:
        return

    user_message = {"role": "user", "content": user_input}
    st.session_state.messages.append(user_message)
    _render_message(user_message)
    ensure_session(st.session_state.session_id, user_input[:30])
    save_message(
        session_id=st.session_state.session_id,
        role="user",
        content=user_input,
    )

    with st.chat_message("assistant"):
        answer_placeholder = st.empty()
        thinking_placeholder = st.empty()

        thinking_placeholder.markdown("正在思考中...")

        result = asyncio.run(
            stream_search_assistant(
                user_input=user_input,
                session_id=st.session_state.session_id,
            )
        )

        answer = result.get("answer") or "当前没有生成有效答案。"
        meta = (
            f"answer_status={result.get('answer_status')} | "
            f"retrieval_status={result.get('retrieval_status')} | "
            f"provider={result.get('provider_used') or 'unknown'}"
        )

        thinking_placeholder.empty()
        streamed_answer = answer_placeholder.write_stream(_stream_answer_text(answer))

        assistant_message = {
            "role": "assistant",
            "content": streamed_answer or answer,
            "sources": result.get("sources", []),
            "meta": meta,
        }
        st.session_state.messages.append(assistant_message)
        save_message(
            session_id=st.session_state.session_id,
            role="assistant",
            content=assistant_message["content"],
            sources=assistant_message["sources"],
            meta=assistant_message["meta"],
        )


if __name__ == "__main__":
    main()
