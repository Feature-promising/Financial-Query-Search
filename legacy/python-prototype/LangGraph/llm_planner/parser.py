import json
import re

from llm_planner.models import ToolPlan


def _default_plan(note: str) -> ToolPlan:
    return {
        "needs_tools": False,
        "answerable_without_tools": True,
        "planned_calls": [],
        "confidence": 0.0,
        "planner_notes": note,
    }


def _try_parse_json_object(candidate: str) -> dict | None:
    try:
        data = json.loads(candidate)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _extract_fenced_json(text: str) -> str | None:
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.DOTALL)
    if match:
        return match.group(1).strip()
    return None


def _extract_first_json_object(text: str) -> str | None:
    start = text.find("{")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escaped = False

    for index in range(start, len(text)):
        char = text[index]

        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1].strip()

    return None


def parse_tool_plan(text: str) -> ToolPlan:
    """
    Parse LLM planner output with a few tolerant fallbacks:
    1. direct JSON
    2. fenced ```json ... ```
    3. first top-level JSON object embedded in text
    """
    raw_text = (text or "").strip()
    candidates = [
        raw_text,
        _extract_fenced_json(raw_text),
        _extract_first_json_object(raw_text),
    ]

    data = None
    for candidate in candidates:
        if not candidate:
            continue
        data = _try_parse_json_object(candidate)
        if data is not None:
            break

    if data is None:
        preview = raw_text.replace("\n", " ")
        return _default_plan(f"invalid json: {preview[:300]}")

    return {
        "needs_tools": bool(data.get("needs_tools", False)),
        "answerable_without_tools": bool(data.get("answerable_without_tools", False)),
        "planned_calls": list(data.get("planned_calls", [])),
        "confidence": float(data.get("confidence", 0.0)),
        "planner_notes": str(data.get("planner_notes", "")),
    }
