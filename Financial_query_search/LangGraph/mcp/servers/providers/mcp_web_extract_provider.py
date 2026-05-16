class MCPWebExtractProvider:
    async def call_tool(self, tool_name: str, arguments: dict) -> dict:
        url = arguments.get("url", "").strip()
        if not url:
            return {
                "success": False,
                "error": "missing url for web_extract_mcp",
                "metadata": {"tool_name": tool_name},
            }

        return {
            "success": True,
            "content": [
                {
                    "url": url,
                    "title": f"Extracted page: {url}",
                    "site_name": "placeholder",
                    "published_at": None,
                    "summary": "web_extract_mcp placeholder result",
                    "main_text": (
                        "This is a placeholder extraction result. "
                        "Replace MCPWebExtractProvider with a real page extraction backend."
                    ),
                    "author": None,
                    "language": None,
                }
            ],
            "metadata": {"tool_name": tool_name, "status": "placeholder"},
        }
