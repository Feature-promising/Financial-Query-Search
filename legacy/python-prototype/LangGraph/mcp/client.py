import asyncio
from typing import Any

from mcp.types import MCPToolCall, MCPToolResult


class MCPClient:
    def __init__(self, server_map: dict[str, Any]) -> None:
        self.server_map = server_map

    async def call_tool(self, tool_call: MCPToolCall) -> MCPToolResult:
        server = self.server_map.get(tool_call.tool_name)

        if server is None:
            return MCPToolResult(
                tool_name=tool_call.tool_name,
                success=False,
                error=f"unknown MCP tool: {tool_call.tool_name}",
            )

        try:
            result = await asyncio.wait_for(
                server.call_tool(tool_call.tool_name, tool_call.arguments),
                timeout=tool_call.timeout_seconds
            )
        except Exception as exc:
            return MCPToolResult(
                tool_name=tool_call.tool_name,
                success=False,
                error=str(exc),
            )
        
        return MCPToolResult(
            tool_name=tool_call.tool_name,
            success=result.get("success", True),
            content=result.get("content", []),
            error=result.get("error"),
            metadata=result.get("metadata", {}),
        )
