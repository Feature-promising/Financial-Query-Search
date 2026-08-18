from typing import Literal, TypedDict

ToolName = Literal[
    "web_extract_mcp",
    "filing_reader_mcp",
    "financial_data_mcp",
]


class PlannedToolCall(TypedDict):
    tool_name: ToolName
    arguments: dict
    reason: str

class ToolPlan(TypedDict):
    needs_tools: bool
    answerable_without_tools: bool
    planned_calls: list[PlannedToolCall]
    confidence: float
    planner_notes: str