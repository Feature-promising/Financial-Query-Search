class MCPFinancialDataProvider:
    async def call_tool(self, tool_name: str, arguments: dict) -> dict:
        company_name = arguments.get("company_name")
        ticker = arguments.get("ticker")
        if not company_name and not ticker:
            return {
                "success": False,
                "error": "missing company_name or ticker for financial_data_mcp",
                "metadata": {"tool_name": tool_name},
            }

        return {
            "success": True,
            "content": [],
            "metadata": {
                "tool_name": tool_name,
                "status": "placeholder",
                "message": "financial_data_mcp is wired but has no backend yet",
            },
        }
