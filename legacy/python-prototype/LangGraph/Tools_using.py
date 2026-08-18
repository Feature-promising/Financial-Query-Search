import asyncio
import inspect
import logging
import os
import re
from typing import Annotated, Any, Callable, Literal, TypedDict

from dotenv import load_dotenv
from langchain_community.chat_models.tongyi import ChatTongyi
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from search.models import SearchRequest
from search.providers.playwright_provider import PlaywrightProvider
from search.providers.tavily_provider import TavilyProvider
from search.router import SearchRouter
from search.service import SearchService

# from rag.models import RAGRequest
# from rag.router import RAGRouter
# from rag.service import LlamaIndexEmbeddingProvider, RAGService
# from rag.store import QdrantStore

# from llama_index.embeddings.dashscope import DashScopeEmbedding

from evidence.merge import merge_evidence
from mcp.client import MCPClient
from mcp.servers.providers.mcp_filing_provider import MCPFilingProvider
from mcp.servers.providers.mcp_financial_data_provider import (
    MCPFinancialDataProvider,
)
from mcp.servers.providers.mcp_local_docs_provider import MCPLocalDocsProvider
from mcp.servers.providers.mcp_web_extract_provider import MCPWebExtractProvider
from mcp.types import MCPToolCall, MCPToolResult


from llm_planner.guardrails import validate_planned_calls
from llm_planner.models import ToolPlan
from llm_planner.parser import parse_tool_plan

load_dotenv()
logging.basicConfig(level=logging.INFO)

chat = ChatTongyi(model="qwen3-max", temperature=0.3)

tavily_provider = TavilyProvider(api_key=os.getenv("TAVILY_API_KEY"))
playwright_provider = PlaywrightProvider(
    enabled=True,
    headless=True,
    page_timeout_ms=15000,
    max_results=3,
)
search_router = SearchRouter(
    tavily_provider=tavily_provider,
    playwright_provider=playwright_provider,
)
search_service = SearchService(
    router=search_router,
    per_provider_timeout=12.0,
    max_retries=2,
    base_backoff=0.8,
)
mcp_client = MCPClient(
    server_map={
        "web_extract_mcp": MCPWebExtractProvider(),
        "local_docs_mcp": MCPLocalDocsProvider(),
        "filing_reader_mcp": MCPFilingProvider(),
        "financial_data_mcp": MCPFinancialDataProvider(),
    }
)

# RAG部署
# rag_embed_model = DashScopeEmbedding(
#     model_name="text-embedding-v4",
#     api_key=os.getenv("DASHSCOPE_API_KEY"),
# )
# rag_embedding_provider = LlamaIndexEmbeddingProvider(embed_model=rag_embed_model)
# rag_store = QdrantStore(
#     collection_name="agent_memory",
#     embedding_dim=3072,
#     host="localhost",
#     port=6333,
# )

# rag_router = RAGRouter()
# rag_service = RAGService(
#     store=rag_store,
#     embedding_provider=rag_embedding_provider,
# )


class CapabilityPlan(TypedDict):
    use_web_search: bool
    use_web_extract_mcp: bool
    use_local_docs_mcp: bool
    use_filing_reader_mcp: bool
    use_financial_data_mcp: bool
    reason: str


class SearchState(TypedDict):
    messages: Annotated[list, add_messages]
    user_query: str
    intent_summary: str
    normalized_date: str
    market: str
    entity: str
    region: str
    search_query: str
    search_results: str
    final_answer: str
    step: str
    retrieval_status: str
    answer_status: str
    verification_notes: str
    rewritten_queries: list[str]
    provider_used: str
    source_items: list[dict[str, str]]
    attempt_count: int
    max_attempts: int

    capability_plan: CapabilityPlan
    mcp_tool_calls: list[MCPToolCall]
    mcp_results: list[MCPToolResult]
    evidence_text: str
    evidence_items: list[dict]

    tool_plan: ToolPlan
    planner_rejections: list[str]


def _latest_user_message(state: SearchState) -> str:
    for msg in reversed(state["messages"]):
        if isinstance(msg, HumanMessage):
            return str(msg.content)
    return state.get("user_query", "")


def _parse_tagged_field(text: str, prefixes: list[str], default: str) -> str:
    for prefix in prefixes:
        if prefix in text:
            return text.split(prefix, 1)[1].strip()
    return default


"""understand_query_node"""
def understand_query_node(state: SearchState) -> SearchState:
    user_message = _latest_user_message(state)
    prompt = f"""
        你是检索任务分析器。请分析用户问题，并严格输出以下六行：

        理解: <一句话概括用户真正要查什么>
        日期: <若有明确日期则提取；没有则写 unknown>
        市场: <如 美股/A股/港股/加密/外汇；没有则写 unknown>
        实体: <公司、指数、行业、人物、产品等核心对象；没有则写 unknown>
        地域: <国家/地区；没有则写 unknown>
        索词: <适合首轮真实搜索的 query，必须保留日期、市场、实体、地域等约束，必要时补充英文关键词、别名、官方简称>

        用户问题:
        {user_message}
    """
    response = chat.invoke([SystemMessage(content=prompt)])
    response_text = str(response.content)
    
    intent_summary = _parse_tagged_field(response_text, ["理解:"], user_message)
    normalized_date = _parse_tagged_field(response_text, ["日期:"], "unknown")
    market = _parse_tagged_field(response_text, ["市场:"], "unknown")
    entity = _parse_tagged_field(response_text, ["实体:"], "unknown")
    region = _parse_tagged_field(response_text, ["地域:"], "unknown")
    search_query = _parse_tagged_field(response_text, ["搜索词:", "检索词:"], user_message)

    return {
        "user_query": user_message,
        "intent_summary": intent_summary,
        "normalized_date": normalized_date,
        "market": market,
        "entity": entity,
        "region": region,
        "search_query": search_query,
        "step": "understood",
        "retrieval_status": "pending",
        "answer_status": "pending",
        "verification_notes": "",
        "messages": [
            AIMessage(
                content=(
                    f"已完成问题理解。\n"
                    f"意图: {intent_summary}\n"
                    f"日期: {normalized_date}\n"
                    f"市场: {market}\n"
                    f"实体: {entity}\n"
                    f"地域: {region}\n"
                    f"首轮检索词: {search_query}"
                )
            )
        ],
    }


"""plan_capabilities_node"""
def plan_capabilities_node(state: SearchState) -> SearchState:
    user_query = (state.get("user_query") or "").lower()
    entity = state.get("entity", "unknown")
    normalized_date = state.get("normalized_date", "unknown")

    filing_keywords = [
        "财报", "年报", "季报", "公告", "10-k", "10-q", "8-k",
        "earnings", "filing", "sec", "guidance", "management discussion",
    ]
    metric_keywords = [
        "营收", "收入", "净利润", "利润", "eps", "pe", "估值", "市值",
        "revenue", "net income", "margin", "ebitda", "cash flow",
    ]
    local_doc_keywords = [
        "本地", "内部", "资料", "研报", "笔记", "文档", "报告", "知识库",
    ]
    web_extract_keywords = [
        "官网", "网页", "链接", "报道", "新闻", "文章", "原文", "source", "url",
    ]

    use_filing_reader = any(k in user_query for k in filing_keywords)
    use_financial_data = any(k in user_query for k in metric_keywords)
    use_local_docs = any(k in user_query for k in local_doc_keywords)
    use_web_extract = any(k in user_query for k in web_extract_keywords)

    plan: CapabilityPlan = {
        "use_web_search": True,
        "use_web_extract_mcp": use_web_extract or use_filing_reader,
        "use_local_docs_mcp": use_local_docs or entity != "unknown",
        "use_filing_reader_mcp": use_filing_reader,
        "use_financial_data_mcp": use_financial_data,
        "reason": (
            f"entity={entity}, date={normalized_date}, "
            f"filing={use_filing_reader}, financial_data={use_financial_data}, "
            f"local_docs={use_local_docs}, web_extract={use_web_extract}"
        ),
    }

    return {
        "capability_plan": plan,
        "step": "capability_planned",
    }


def _extract_urls(text: str) -> list[str]:
    return re.findall(r"https?://[^\s)>\]]+", text or "")


def _normalize_planned_calls(
    planned_calls: list[dict[str, Any]],
    user_query: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    """
    Prefer the shared guardrails module, but keep a local fallback normalization
    so the workflow still works if the external guardrail implementation is partial.
    """
    validated_calls, rejected = validate_planned_calls(planned_calls, user_query=user_query)

    kept_pairs = {
        (
            call.get("tool_name"),
            repr(call.get("arguments", {})),
        )
        for call in validated_calls
    }

    urls_in_query = _extract_urls(user_query)
    lowered_query = (user_query or "").lower()
    financial_keywords = [
        "营收", "收入", "净利润", "利润", "eps", "pe", "市值", "估值",
        "revenue", "net income", "gross margin", "margin", "ebitda", "cash flow",
    ]
    filing_keywords = [
        "财报", "年报", "季报", "公告", "10-k", "10-q", "8-k",
        "filing", "sec", "guidance", "management discussion",
    ]

    for raw_call in planned_calls:
        tool_name = raw_call.get("tool_name")
        arguments = dict(raw_call.get("arguments", {}))
        pair = (tool_name, repr(arguments))

        if pair in kept_pairs:
            continue

        if tool_name == "web_extract_mcp":
            url = arguments.get("url")
            if not url and len(urls_in_query) == 1:
                arguments["url"] = urls_in_query[0]
                url = arguments["url"]
            if not url:
                rejected.append("web_extract_mcp missing url")
                continue
        elif tool_name == "filing_reader_mcp":
            if not any(keyword in lowered_query for keyword in filing_keywords):
                rejected.append("filing_reader_mcp rejected: no filing signal")
                continue
        elif tool_name == "financial_data_mcp":
            if not any(keyword in lowered_query for keyword in financial_keywords):
                rejected.append("financial_data_mcp rejected: no financial metric signal")
                continue
        else:
            continue

        normalized_call = {
            "tool_name": tool_name,
            "arguments": arguments,
            "reason": raw_call.get("reason", ""),
        }
        validated_calls.append(normalized_call)
        kept_pairs.add((tool_name, repr(arguments)))

    return validated_calls[:3], rejected


def plan_tools_with_llm_node(state: SearchState) -> SearchState:
    user_query = state.get("user_query", "")
    normalized_date = state.get("normalized_date", "unknown")
    market = state.get("market", "unknown")
    entity = state.get("entity", "unknown")
    region = state.get("region", "unknown")

    prompt = f"""
        你是金融问答 Agent 的工具规划器。
        你只能决定是否调用以下工具：

        1. web_extract_mcp
        用途：读取网页正文。仅用于新闻、官网、文章、链接、网页原文内容。
        要求：必须提供 url。

        2. filing_reader_mcp
        用途：读取财报、公告、监管披露文件原文。
        适用：财报、年报、季报、公告、10-K、10-Q、8-K、SEC、管理层讨论、风险因素。

        3. financial_data_mcp
        用途：查询标准化财务指标。
        适用：营收、净利润、EPS、毛利率、现金流、市值、估值、同比、环比等数字型问题。

        规则：
        1. 如果问题不需要工具即可回答，则 needs_tools=false。
        2. 如果需要工具，最多规划 3 个调用。
        3. 不要编造 url。
        4. financial_data_mcp 尽量提供 company_name 或 ticker，和 metrics。
        5. filing_reader_mcp 尽量提供 company_name 或 filing_url。
        6. 输出必须是 JSON，不要输出 markdown 或解释。

        用户问题：
        {user_query}

        结构化信息：
        - 日期: {normalized_date}
        - 市场: {market}
        - 实体: {entity}
        - 地域: {region}

        输出 JSON 格式：
        {{
          "needs_tools": true,
          "answerable_without_tools": false,
          "planned_calls": [
            {{
              "tool_name": "financial_data_mcp",
              "arguments": {{
                "company_name": "Tesla",
                "metrics": ["revenue", "net_income"],
                "period": "latest"
              }},
              "reason": "用户在问财务数字"
            }}
          ],
          "confidence": 0.82,
          "planner_notes": "简短说明"
        }}
    """

    response = chat.invoke([SystemMessage(content=prompt)])
    parsed = parse_tool_plan(str(response.content))

    normalized_calls, rejected = _normalize_planned_calls(
        parsed.get("planned_calls", []),
        user_query=user_query,
    )

    mcp_calls = [
        MCPToolCall(
            tool_name=call["tool_name"],
            arguments=call["arguments"],
        )
        for call in normalized_calls
    ]

    tool_plan: ToolPlan = {
        "needs_tools": bool(parsed.get("needs_tools", False) and mcp_calls),
        "answerable_without_tools": bool(parsed.get("answerable_without_tools", False)),
        "planned_calls": normalized_calls,
        "confidence": float(parsed.get("confidence", 0.0)),
        "planner_notes": str(parsed.get("planner_notes", "")),
    }

    return {
        "tool_plan": tool_plan,
        "planner_rejections": rejected,
        "mcp_tool_calls": mcp_calls,
        "step": "tools_planned",
        "messages": [
            AIMessage(
                content=(
                    f"工具规划完成。计划调用 {len(mcp_calls)} 个工具，"
                    f" 拒绝 {len(rejected)} 个。"
                )
            )
        ],
    }


def route_after_tool_planning(
    state: SearchState,
) -> Literal["execute_mcp_calls", "search"]:
    tool_plan = state.get("tool_plan", {})
    mcp_tool_calls = state.get("mcp_tool_calls", [])
    if tool_plan.get("needs_tools") and mcp_tool_calls:
        return "execute_mcp_calls"
    return "search"


def build_mcp_calls_node(state: SearchState) -> SearchState:
    plan = state.get("capability_plan", {})
    user_query = state.get("user_query", "")
    entity = state.get("entity", "unknown")
    normalized_date = state.get("normalized_date", "unknown")

    calls: list[MCPToolCall] = []
    if plan.get("use_local_docs_mcp"):
        calls.append(
            MCPToolCall(
                tool_name="local_docs_mcp",
                arguments={
                    "query": user_query,
                    "top_k": 5,
                },
            )
        )

    if plan.get("use_web_extract_mcp"):
        for url in _extract_urls(user_query):
            calls.append(
                MCPToolCall(
                    tool_name="web_extract_mcp",
                    arguments={
                        "url": url,
                        "max_chars": 8000,
                        "include_summary": True,
                        "include_published_at": True,
                    },
                )
            )

    if plan.get("use_filing_reader_mcp"):
        calls.append(
            MCPToolCall(
                tool_name="filing_reader_mcp",
                arguments={
                    "company_name": None if entity == "unknown" else entity,
                    "date_from": None if normalized_date == "unknown" else normalized_date,
                    "max_passages": 5,
                },
            )
        )

    if plan.get("use_financial_data_mcp"):
        calls.append(
            MCPToolCall(
                tool_name="financial_data_mcp",
                arguments={
                    "company_name": None if entity == "unknown" else entity,
                    "metrics": ["revenue", "net_income", "eps", "market_cap"],
                    "period": "latest",
                },
            )
        )
    
    return {
        "mcp_tool_calls": calls,
        "step": "mcp_calls_built",
    }


def route_after_plan_capabilities(state: SearchState) -> Literal["search", "build_mcp_calls"]:
    plan = state.get("capability_plan", {})
    need_mcp = any(
        [
            plan.get("use_web_extract_mcp"),
            plan.get("use_local_docs_mcp"),
            plan.get("use_filing_reader_mcp"),
            plan.get("use_financial_data_mcp"),
        ]
    )
    return "build_mcp_calls" if need_mcp else "search"


def route_after_search(state: SearchState) -> Literal["merge_evidence", "verify_retrieval"]:
    has_search = bool(state.get("source_items"))
    has_mcp = bool(state.get("mcp_results"))
    if has_search or has_mcp:
        return "merge_evidence"
    return "verify_retrieval"


async def execute_mcp_calls_node(state: SearchState) -> SearchState:
    tool_calls = state.get("mcp_tool_calls", [])
    if not tool_calls:
        return {
            "mcp_results": [],
            "step": "mcp_executed",
            "messages": [AIMessage(content="未命中需要执行的 MCP 工具。")],
        }

    results = await asyncio.gather(
        *(mcp_client.call_tool(tool_call) for tool_call in tool_calls)
    )

    success_count = sum(1 for result in results if result.success)
    failure_count = len(results) - success_count
    return {
        "mcp_results": results,
        "step": "mcp_executed",
        "messages": [
            AIMessage(
                content=(
                    f"MCP 工具执行完成。成功 {success_count} 个，失败 {failure_count} 个。"
                )
            )
        ],
    }


"""unified_search_node"""
async def unified_search_node(state: SearchState) -> SearchState:
    search_query = state["search_query"]
    attempt_count = state.get("attempt_count", 0) + 1

    request = SearchRequest(
        query=search_query,
        user_query=state.get("user_query", ""),
        trace_id=f"attempt-{attempt_count}",
        policy="default",
        max_results=5,
        timeout_seconds=20.0,
    )

    try:
        response = await search_service.search(request)
    except Exception as exc:
        error_msg = f"搜索服务调用异常: {exc}"
        return {
            "search_results": error_msg,
            "provider_used": "none",
            "retrieval_status": "tool_failed",
            "verification_notes": error_msg,
            "step": "search_failed",
            "attempt_count": attempt_count,
            "messages": [AIMessage(content=error_msg)],
        }

    if not response.success:
        error_msg = response.error or "所有搜索提供方均失败"
        return {
            "search_results": error_msg,
            "provider_used": response.provider,
            "retrieval_status": "tool_failed",
            "verification_notes": error_msg,
            "step": "search_failed",
            "attempt_count": attempt_count,
            "messages": [AIMessage(content=f"检索失败: {error_msg}")],
        }

    return {
        "search_results": response.to_prompt_text(),
        "provider_used": response.provider,
        "source_items": [
            {
                "title": item.title,
                "content": item.content,
                "url": item.url,
            }
            for item in response.items
        ],
        "retrieval_status": "pending",
        "verification_notes": "",
        "step": "searched",
        "attempt_count": attempt_count,
        "messages": [AIMessage(content=f"第 {attempt_count} 轮检索完成，当前来源: {response.provider}")],
    }


"""rag_search_node"""
"""
def rag_search_node(state: SearchState) -> SearchState:
    filters = rag_router.build_filters(
        market=state.get("market", "unknown"),
        entity=state.get("entity", "unknown"),
        region=state.get("region", "unknown"),
    )

    request = RAGRequest(
        query=state.get("search_query", ""),
        user_query=state.get("user_query", ""),
        top_k=3,
        filters=filters,
    )

    response = rag_service.retrieve(request)

    if not response.success:
        error_msg = response.error or "RAG 检索失败"
        return {
            "search_results": error_msg,
            "provider_used": "rag",
            "retrieval_status": "tool_failed",
            "verification_notes": error_msg,
            "step": "search_failed",
            "messages": [AIMessage(content=f"RAG 检索失败: {error_msg}")],
        }

    return {
        "search_results": response.to_prompt_text(),
        "provider_used": "rag",
        "retrieval_status": "pending",
        "verification_notes": "",
        "step": "searched",
        "messages": [AIMessage(content="RAG 检索完成，已加载固定知识记忆。")],
    }

"""

"""merge_evidence_node"""
def merge_evidence_node(state: SearchState) -> SearchState:

    bundle = merge_evidence(
        search_items=state.get("source_items", []),
        search_provider=state.get("provider_used", "unknown"),
        mcp_results=state.get("mcp_results", []),
    )
    return {
            "evidence_text": bundle.summary,
            "evidence_items": [
                {
                    "source_type": item.source_type,
                    "provider": item.provider,
                    "title": item.title,
                    "content": item.content,
                    "url_or_path": item.url_or_path,
                    "entity": item.entity,
                    "published_at": item.published_at,
                    "confidence": item.confidence,
                    "metadata": item.metadata,
                }
                for item in bundle.items
            ],
            "search_results": bundle.summary, 
            "step": "evidence_merged",
        }

"""规则校验函数"""
def _split_constraint_terms(value: str) -> list[str]:
    if not value or value == "unknown":
        return []

    separators = [",", "，", "/", "|", ";", "；"]
    terms = [value]

    for sep in separators:
        expanded = []
        for item in terms:
            expanded.extend(item.split(sep))
        terms = expanded

    cleaned = []
    for term in terms:
        normalized = term.strip()
        if normalized:
            cleaned.append(normalized)

    return cleaned

def _rule_check_retrieval(state: SearchState) -> dict:
    search_results = (state.get("search_results", "") or "").strip()

    if state.get("step") == "search_failed":
        return {
            "status": "hard_fail",
            "retrieval_status": "tool_failed",
            "reason": "搜索工具调用失败，当前没有可验证的检索证据。",
        }

    if not search_results:
        return {
            "status": "hard_fail",
            "retrieval_status": "insufficient",
            "reason": "检索结果为空。",
        }

    error_markers = ["搜索失败", "调用异常", "error", "exception", "traceback"]
    lowered_results = search_results.lower()
    if any(marker.lower() in lowered_results for marker in error_markers):
        return {
            "status": "hard_fail",
            "retrieval_status": "tool_failed",
            "reason": "检索结果中包含错误信息，无法作为有效证据。",
        }

    if len(search_results) < 80:
        return {
            "status": "hard_fail",
            "retrieval_status": "insufficient",
            "reason": "检索结果过短，信息量不足。",
        }

    constraint_map = {
        "日期": _split_constraint_terms(state.get("normalized_date", "unknown")),
        "市场": _split_constraint_terms(state.get("market", "unknown")),
        "实体": _split_constraint_terms(state.get("entity", "unknown")),
        "地域": _split_constraint_terms(state.get("region", "unknown")),
    }

    matched_constraints = []
    missing_constraints = []

    for label, terms in constraint_map.items():
        if not terms:
            continue

        hit = any(term.lower() in lowered_results for term in terms)
        if hit:
            matched_constraints.append(label)
        else:
            missing_constraints.append(label)

    matched_count = len(matched_constraints)
    constrained_count = sum(1 for terms in constraint_map.values() if terms)

    if constrained_count == 0:
        return {
            "status": "pass",
            "retrieval_status": "pending",
            "reason": "未提取到明确结构化约束，进入语义验证。",
        }

    if matched_count == 0:
        return {
            "status": "weak_fail",
            "retrieval_status": "mismatched",
            "reason": f"规则检查未命中任何关键约束，缺失约束: {', '.join(missing_constraints)}。",
        }

    return {
        "status": "pass",
        "retrieval_status": "pending",
        "reason": (
            f"规则检查已命中约束: {', '.join(matched_constraints)}；"
            f"缺失约束: {', '.join(missing_constraints) if missing_constraints else '无'}。"
        ),
    }


"""
verify_retrieval_node (rule_verify and LLM_verify)
"""
def verify_retrieval_node(state: SearchState) -> SearchState:
    rule_result = _rule_check_retrieval(state)

    if rule_result["status"] == "hard_fail":
        return {
            "retrieval_status": rule_result["retrieval_status"],
            "verification_notes": f"[规则检查] {rule_result['reason']}",
            "step": "retrieval_verified",
            "messages": [
                AIMessage(
                    content=f"检索验证结果: {rule_result['retrieval_status']}。{rule_result['reason']}"
                )
            ],
        }


    prompt = f"""
        你是检索结果语义验证器。请判断当前检索结果是否足以回答用户问题。

        重要规则:
        1. 优先依据“检索条目证据”判断是否足够回答。
        2. 若检索结果中含有“搜索摘要参考”，只能把它当作辅助线索，不能单独作为充分证据。
        3. 只有当摘要中的结论能被条目证据支持时，才可视为有效。

        用户问题:
        {state.get('user_query', '')}

        结构化约束:
        - 日期: {state.get('normalized_date', 'unknown')}
        - 市场: {state.get('market', 'unknown')}
        - 实体: {state.get('entity', 'unknown')}
        - 地域: {state.get('region', 'unknown')}

        检索结果:
        {state.get('search_results', '')}

        规则检查结论:
        {rule_result['reason']}

        请严格输出三行:
        状态: sufficient / insufficient / mismatched
        原因: <简洁说明>
        建议: answer / rewrite

        判断标准:
        1. 结果是否足以直接回答问题。
        2. 是否覆盖了用户问题中的核心约束。
        3. 即使没有逐字匹配，也可以根据语义判断是否在讨论同一对象、同一市场、同一时间范围。
        4. 若只有背景信息但缺少关键事实，判 insufficient。
        5. 若主题明显偏离，判 mismatched。
    """

    response = chat.invoke([SystemMessage(content=prompt)])
    text = str(response.content)

    status = _parse_tagged_field(text, ["状态:"], "insufficient").lower()
    note = _parse_tagged_field(text, ["原因:"], text)

    normalized_status: Literal["sufficient", "insufficient", "mismatched"]
    if "sufficient" in status:
        normalized_status = "sufficient"
    elif "mismatch" in status:
        normalized_status = "mismatched"
    else:
        normalized_status = "insufficient"

    final_note = f"[规则检查] {rule_result['reason']} [语义判断] {note}"

    return {
        "retrieval_status": normalized_status,
        "verification_notes": final_note,
        "step": "retrieval_verified",
        "messages": [
            AIMessage(content=f"检索验证结果: {normalized_status}。{note}")
        ],
    }


"""
rewrite_query_node
"""
def rewrite_query_node(state: SearchState) -> SearchState:
    attempt_count = state.get("attempt_count", 0)
    max_attempts = state.get("max_attempts", 2)
    existing_queries = state.get("rewritten_queries", [])

    if attempt_count >= max_attempts:
        note = f"已达到最大重试次数 {max_attempts}，不再继续改写查询。"
        return {
            "retrieval_status": "max_retry_reached",
            "verification_notes": note,
            "step": "rewrite_skipped",
            "messages": [AIMessage(content=note)],
        }

    
    user_query = state.get("user_query", "")
    current_query = state.get("search_query", "")
    normalized_date = state.get("normalized_date", "unknown")
    market = state.get("market", "unknown")
    entity = state.get("entity", "unknown")
    region = state.get("region", "unknown")
    verification_notes = state.get("verification_notes", "")

    prompt = f"""
        你是搜索查询改写器。请根据用户问题和当前检索失败原因，给出一个更适合下一轮真实搜索的新查询词。

        用户原问题:
        {user_query}

        当前查询词:
        {current_query}

        结构化约束:
        - 日期: {normalized_date}
        - 市场: {market}
        - 实体: {entity}
        - 地域: {region}

        上轮检索验证反馈:
        {verification_notes}

        历史改写查询:
        {existing_queries}

        请遵循以下规则：
        1. 必须保留核心硬约束，尤其是日期、市场、实体、地域，除非某项明确为 unknown。
        2. 如果上轮结果过泛，请把查询改得更具体。
        3. 如果上轮结果跑题，请收紧主题范围，减少歧义词。
        4. 可以补充英文关键词、同义词、官方简称、指数简称、行业英文名。
        5. 不要改写用户原始年份、日期或时间范围。
        6. 不要输出解释，只输出一行。

        输出格式必须严格为：
        新查询词: <改写后的查询词>
        """
    
    response = chat.invoke([SystemMessage(content=prompt)])
    response_text = str(response.content)

    new_query = _parse_tagged_field(
        response_text,
        ["新查询词:", "搜索词:", "检索词:"],
        current_query,
    ).strip()

    if not new_query:
        new_query = current_query

    updated_queries = [*existing_queries, new_query]

    return {
        "search_query": new_query,
        "rewritten_queries": updated_queries,
        "search_results": "",
        "source_items": [],
        "mcp_tool_calls": [],
        "mcp_results": [],
        "evidence_text": "",
        "evidence_items": [],
        "tool_plan": {
            "needs_tools": False,
            "answerable_without_tools": False,
            "planned_calls": [],
            "confidence": 0.0,
            "planner_notes": "",
        },
        "planner_rejections": [],
        "step": "rewritten",
        "messages": [
            AIMessage(
                content=(
                    f"已根据检索验证反馈改写查询词。\n"
                    f"上一轮查询: {current_query}\n"
                    f"新查询词: {new_query}"
                )
            )
        ],
    }


"""
generate_answer_node
"""
def generate_answer_node(state: SearchState) -> SearchState:
    if state.get("retrieval_status") != "sufficient":
        safe_answer = (
            "当前检索结果不足以可靠回答这个问题。"
            f" 已尝试 {state.get('attempt_count', 0)} 轮检索。"
            f" 最近一次验证结论: {state.get('verification_notes', '无')}"
        )
        return {
            "final_answer": safe_answer,
            "answer_status": "abstain",
            "step": "answered",
            "messages": [AIMessage(content=safe_answer)],
        }

    prompt = f"""
        你是答案生成器。只能基于已验证通过的检索结果回答，不要补充证据之外的具体事实。

        重要规则:
        1. 优先使用“检索条目证据”中的事实、数字、时间和来源。
        2. 如果检索结果中存在“搜索摘要参考”，只能把它当作辅助理解材料，不能把其中未被条目证据支持的内容写进答案。
        3. 若条目证据不足，即使摘要看起来完整，也要明确说明信息不足。

        用户问题:
        {state.get('user_query', '')}

        检索结果:
        {state.get('search_results', '')}

        要求:
        1. 回答要直接解决用户问题。
        2. 重要结论要尽量引用来源线索。
        3. 如果信息仍有不完整处，要明确指出。
    """
    response = chat.invoke([SystemMessage(content=prompt)])
    answer = str(response.content)
    return {
        "final_answer": answer,
        "answer_status": "pending",
        "step": "answered",
        "messages": [AIMessage(content=answer)],
    }



"""
verify_answer_node
"""
def verify_answer_node(state: SearchState) -> SearchState:

    retrieval_status = state.get("retrieval_status", "pending")
    final_answer = state.get("final_answer", "").strip()
    search_results = state.get("search_results", "").strip()
    user_query = state.get("user_query", "").strip()

    if retrieval_status != "sufficient":
        note = "检索证据未通过验证，因此答案无法被视为有证据支撑。"
        return {
            "answer_status": "unsupported",
            "verification_notes": note,
            "step": "answer_verified",
            "messages": [AIMessage(content=f"答案校验结果: unsupported。{note}")],
        }
    
    if not final_answer:
        note = "候选答案为空，无法通过答案校验。"
        return {
            "answer_status": "unsupported",
            "verification_notes": note,
            "step": "answer_verified",
            "messages": [AIMessage(content=f"答案校验结果: unsupported。{note}")],
        }
    
    if not search_results:
        note = "缺少检索证据文本，无法校验答案是否被支持。"
        return {
            "answer_status": "unsupported",
            "verification_notes": note,
            "step": "answer_verified",
            "messages": [AIMessage(content=f"答案校验结果: unsupported。{note}")],
        }
    
    prompt = f"""
        你是答案校验器。请判断候选答案是否被检索证据支持。

        重要规则:
        1. 优先依据“检索条目证据”进行校验。
        2. 若检索结果中存在“搜索摘要参考”，不能仅凭摘要就判定答案被支持。
        3. 候选答案中的关键事实、数字、时间判断，必须能在条目证据中找到依据，或至少被条目证据明确支撑。

        用户问题:
        {user_query}

        结构化约束:
        - 日期: {state.get('normalized_date', 'unknown')}
        - 市场: {state.get('market', 'unknown')}
        - 实体: {state.get('entity', 'unknown')}
        - 地域: {state.get('region', 'unknown')}

        检索证据:
        {search_results}

        候选答案:
        {final_answer}

        请严格输出三行:
        状态: grounded / partial / unsupported
        原因: <简洁说明>
        建议: end / rewrite

        判断标准:
        1. 答案中的关键结论必须能在检索证据中找到依据。
        2. 如果答案加入了检索证据中没有出现的关键事实、数字、时间判断或强结论，判为 unsupported。
        3. 如果答案大体正确，但只回答了部分问题，或对关键约束覆盖不完整，判为 partial。
        4. 如果答案基本被证据完整支持，判为 grounded。
        5. 不要因为措辞不同就判失败，重点看事实是否被支持。
    """

    response = chat.invoke([SystemMessage(content=prompt)])
    response_text = str(response.content)

    status = _parse_tagged_field(response_text, ["状态:"], "unsupported").lower()
    note = _parse_tagged_field(response_text, ["原因:"], response_text)

    if "grounded" in status:
        answer_status = "grounded"
    elif "partial" in status:
        answer_status = "partial"
    else:
        answer_status = "unsupported"

    return {
        "answer_status": answer_status,
        "verification_notes": note,
        "step": "answer_verified",
        "messages": [
            AIMessage(content=f"答案校验结果: {answer_status}。{note}")
        ],
    }


def route_after_retrieval_verification(state: SearchState) -> str:
    retrieval_status = state.get("retrieval_status", "")
    attempt_count = state.get("attempt_count", 0)
    max_attempts = state.get("max_attempts", 2)

    if retrieval_status == "sufficient":
        return "answer"

    if attempt_count >= max_attempts:
        return "answer"

    if retrieval_status in {"insufficient", "mismatched", "tool_failed"}:
        return "rewrite"

    return "answer"


def route_after_answer_verification(state: SearchState) -> str:
    answer_status = state.get("answer_status", "")
    attempt_count = state.get("attempt_count", 0)
    max_attempts = state.get("max_attempts", 2)

    if answer_status in {"grounded", "partial", "abstain"}:
        return END

    if answer_status == "unsupported" and attempt_count < max_attempts:
        return "rewrite"

    return END


def create_search_assistant():
    workflow = StateGraph(SearchState)

    workflow.add_node("understand", understand_query_node)
    workflow.add_node("plan_tools", plan_tools_with_llm_node)
    workflow.add_node("execute_mcp_calls", execute_mcp_calls_node)
    workflow.add_node("merge_evidence", merge_evidence_node)
    workflow.add_node("search", unified_search_node)
    # workflow.add_node("search", rag_search_node)
    workflow.add_node("verify_retrieval", verify_retrieval_node)
    workflow.add_node("rewrite_query", rewrite_query_node)
    workflow.add_node("answer", generate_answer_node)
    workflow.add_node("verify_answer", verify_answer_node)

    workflow.add_edge(START, "understand")
    workflow.add_edge("understand", "plan_tools")
    workflow.add_conditional_edges(
        "plan_tools",
        route_after_tool_planning,
        {
            "execute_mcp_calls": "execute_mcp_calls",
            "search": "search",
        },
    )
    workflow.add_edge("execute_mcp_calls", "search")
    workflow.add_conditional_edges(
        "search",
        route_after_search,
        {
            "merge_evidence": "merge_evidence",
            "verify_retrieval": "verify_retrieval",
        },
    )  
    workflow.add_edge("merge_evidence", "verify_retrieval")
    workflow.add_conditional_edges(
        "verify_retrieval",
        route_after_retrieval_verification,
        {
            "answer": "answer",
            "rewrite": "rewrite_query",
        },
    )
    workflow.add_edge("rewrite_query", "plan_tools")
    workflow.add_edge("answer", "verify_answer")
    workflow.add_conditional_edges(
        "verify_answer",
        route_after_answer_verification,
        {
            "rewrite": "rewrite_query",
            END: END,
        },
    )

    memory = InMemorySaver()
    return workflow.compile(checkpointer=memory)


def build_initial_state(user_input: str) -> SearchState:
    return {
        "messages": [HumanMessage(content=user_input)],
        "user_query": "",
        "intent_summary": "",
        "normalized_date": "unknown",
        "market": "unknown",
        "entity": "unknown",
        "region": "unknown",
        "search_query": "",
        "search_results": "",
        "final_answer": "",
        "step": "start",
        "retrieval_status": "pending",
        "answer_status": "pending",
        "verification_notes": "",
        "rewritten_queries": [],
        "provider_used": "",
        "source_items": [],
        "attempt_count": 0,
        "max_attempts": 2,

        "capability_plan": {
            "use_web_search": True,
            "use_web_extract_mcp": False,
            "use_local_docs_mcp": False,
            "use_filing_reader_mcp": False,
            "use_financial_data_mcp": False,
            "reason": "",
        },
        "mcp_tool_calls": [],
        "mcp_results": [],
        "evidence_text": "",
        "evidence_items": [],
        "tool_plan": {
            "needs_tools": False,
            "answerable_without_tools": False,
            "planned_calls": [],
            "confidence": 0.0,
            "planner_notes": "",
        },
        "planner_rejections": [],
    }


def _node_message(node_output: dict[str, Any]) -> str:
    messages = node_output.get("messages") or []
    if not messages:
        return ""

    latest_message = messages[-1]
    if isinstance(latest_message, AIMessage):
        return str(latest_message.content)

    return ""


def _build_run_result(
    session_id: str,
    final_state: dict[str, Any],
    events: list[dict[str, str]],
) -> dict[str, Any]:
    return {
        "session_id": session_id,
        "answer": final_state.get("final_answer", ""),
        "answer_status": final_state.get("answer_status", "pending"),
        "retrieval_status": final_state.get("retrieval_status", "pending"),
        "provider_used": final_state.get("provider_used", ""),
        "verification_notes": final_state.get("verification_notes", ""),
        "search_query": final_state.get("search_query", ""),
        "sources": final_state.get("evidence_items") or final_state.get("source_items", []),
        "tool_plan": final_state.get("tool_plan", {}),
        "planner_rejections": final_state.get("planner_rejections", []),
        "events": events,
    }


async def stream_search_assistant(
    user_input: str,
    session_id: str,
    event_callback: Callable[[dict[str, Any]], Any] | None = None,
) -> dict[str, Any]:
    app = create_search_assistant()
    config = {"configurable": {"thread_id": session_id}}
    initial_state = build_initial_state(user_input)

    events: list[dict[str, str]] = []
    final_state: dict[str, Any] = {}

    async for output in app.astream(initial_state, config=config):
        for node_name, node_output in output.items():
            event = {
                "node": node_name,
                "message": _node_message(node_output),
            }
            events.append(event)
            final_state.update(node_output)

            if event_callback is not None:
                callback_result = event_callback(
                    {
                        "event": event,
                        "events": list(events),
                        "state": dict(final_state),
                    }
                )
                if inspect.isawaitable(callback_result):
                    await callback_result

    return _build_run_result(session_id, final_state, events)


async def run_search_assistant(user_input: str, session_id: str) -> dict[str, Any]:
    return await stream_search_assistant(user_input=user_input, session_id=session_id)


async def main():
    if not os.getenv("TAVILY_API_KEY"):
        print("错误: 请先配置 TAVILY_API_KEY")
        return

    app = create_search_assistant()
    print("智能搜索助手已启动")
    print("输入 'quit' 退出\n")

    session_count = 0
    while True:
        user_input = input("你想了解什么? ").strip()
        if user_input.lower() in ["quit", "q", "exit"]:
            print("再见")
            break
        if not user_input:
            continue

        session_count += 1
        config = {"configurable": {"thread_id": f"search-session-{session_count}"}}
        initial_state = build_initial_state(user_input)

        try:
            print("\n" + "=" * 60)
            async for output in app.astream(initial_state, config=config):
                for node_name, node_output in output.items():
                    if "messages" not in node_output or not node_output["messages"]:
                        continue
                    latest_message = node_output["messages"][-1]
                    if not isinstance(latest_message, AIMessage):
                        continue
                    if node_name == "answer":
                        print(f"\n最终回答:\n{latest_message.content}")
                    else:
                        print(f"[{node_name}] {latest_message.content}")
            print("=" * 60 + "\n")
        except Exception as exc:
            print(f"运行出错: {exc}")



if __name__ == "__main__":
    asyncio.run(main())



