from llm_planner.models import PlannedToolCall


ALLOWED_TOOLS = {
    "web_extract_mcp",
    "filing_reader_mcp",
    "financial_data_mcp",
}

MAX_TOOL_CALLS_PER_TURN = 3


def _has_financial_metric_signal(text: str) -> bool:
    text = (text or "").lower()
    keywords = [
        "营收", "收入", "净利润", "利润", "eps", "pe", "市值", "估值",
        "revenue", "net income", "gross margin", "margin", "ebitda", "cash flow",
    ]
    return any(k in text for k in keywords)


def _has_filing_signal(text: str) -> bool:
    text = (text or "").lower()
    keywords = [
        "财报", "年报", "季报", "公告", "10-k", "10-q", "8-k",
        "filing", "sec", "guidance", "management discussion",
    ]
    return any(k in text for k in keywords)


def _extract_urls(text: str) -> list[str]:
    import re

    return re.findall(r"https?://[^\s)>\]]+", text or "")


def validate_planned_calls(
    planned_calls: list[PlannedToolCall],
    user_query: str,
) -> tuple[list[PlannedToolCall], list[str]]:
    """
    Return: (accepted calls, rejection reasons)
    """
    filtered: list[PlannedToolCall] = []
    rejected: list[str] = []

    if len(planned_calls) > MAX_TOOL_CALLS_PER_TURN:
        rejected.append(
            f"tool plan exceeds max calls: {len(planned_calls)} > {MAX_TOOL_CALLS_PER_TURN}"
        )
        planned_calls = planned_calls[:MAX_TOOL_CALLS_PER_TURN]

    urls_in_query = _extract_urls(user_query)
    financial_signal = _has_financial_metric_signal(user_query)
    filing_signal = _has_filing_signal(user_query)

    for call in planned_calls:
        tool_name = call.get("tool_name")
        arguments = dict(call.get("arguments", {}))

        if tool_name not in ALLOWED_TOOLS:
            rejected.append(f"tool not allowed: {tool_name}")
            continue

        if tool_name == "web_extract_mcp":
            url = arguments.get("url")
            if not url:
                if len(urls_in_query) == 1:
                    arguments["url"] = urls_in_query[0]
                else:
                    rejected.append("web_extract_mcp missing url")
                    continue

        elif tool_name == "filing_reader_mcp":
            if not filing_signal:
                rejected.append("filing_reader_mcp rejected: no filing signal")
                continue

        elif tool_name == "financial_data_mcp":
            if not financial_signal:
                rejected.append("financial_data_mcp rejected: no financial metric signal")
                continue

        filtered.append(
            {
                "tool_name": tool_name,
                "arguments": arguments,
                "reason": call.get("reason", ""),
            }
        )

    return filtered, rejected
