class MCPLocalDocsProvider:
    async def call_tool(self, tool_name: str, arguments: dict) -> dict:
        query = arguments.get("query", "").strip()
        if not query:
            return {
                "success": False,
                "error": "missing query for local_docs_mcp",
                "metadata": {"tool_name": tool_name},
            }

        return {
            "success": True,
            "content": [],
            "metadata": {
                "tool_name": tool_name,
                "status": "placeholder",
                "message": "local_docs_mcp is wired but has no backend yet",
            },
        }
