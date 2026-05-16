class MCPFilingProvider:
    async def call_tool(self, tool_name: str, arguments: dict) -> dict:
        company_name = arguments.get("company_name")
        filing_url = arguments.get("filing_url")
        if not company_name and not filing_url:
            return {
                "success": False,
                "error": "missing company_name or filing_url for filing_reader_mcp",
                "metadata": {"tool_name": tool_name},
            }

        return {
            "success": True,
            "content": [],
            "metadata": {
                "tool_name": tool_name,
                "status": "placeholder",
                "message": "filing_reader_mcp is wired but has no backend yet",
            },
        }
