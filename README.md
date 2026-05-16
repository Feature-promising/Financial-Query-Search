# Financial Query Search — 金融问答智能搜索助手

基于 **LangGraph** 构建的金融领域智能问答系统。用户用中文提出关于公司、行业、市场或事件的金融问题，系统通过多源搜索、证据验证和 LLM 生成，输出有据可查的答案。

## 架构概览

系统以有状态图（StateGraph）编排整个问答流程：

1. **理解问题** — 提取意图、日期、市场、实体、地域、搜索词
2. **规划能力与工具** — 判断需要哪些搜索能力（网络搜索、文档检索、监管文件、财务指标）
3. **执行搜索** — 通过 Tavily API（主）+ Playwright/Bing（回退）进行网络搜索；通过 MCP 工具获取专业化数据
4. **合并证据** — 将所有来源的结果标准化为统一证据包
5. **验证证据** — 规则检查 + LLM 语义验证，判断是否充分
6. **改写重试** — 证据不足时改写查询词，最多重试 2 次
7. **生成答案** — 基于已验证证据调用 LLM 生成回答
8. **验证答案** — 检查答案中的事实是否都有证据支撑

## 目录结构

```
Financial_query_search/
├── requirements.txt                # Python 依赖
├── .vscode/                        # VS Code 配置
└── LangGraph/
    ├── .env                        # API 密钥（已提交，注意安全）
    ├── Tools_using.py              # 核心：LangGraph 工作流编排（~1345 行）
    ├── chat_ui.py                  # Streamlit 聊天界面
    ├── chat_store.py               # SQLite 会话与消息持久化
    ├── chat_history.db             # SQLite 数据库文件
    ├── search/                     # 网络搜索子系统
    │   ├── models.py               # 请求/响应数据模型
    │   ├── router.py               # 搜索提供方路由
    │   ├── service.py              # 超时、重试、回退编排
    │   └── providers/
    │       ├── base.py             # 抽象基类
    │       ├── tavily_provider.py  # Tavily API 搜索
    │       └── playwright_provider.py  # Playwright+Bing 回退搜索
    ├── evidence/                   # 证据合并子系统
    │   ├── models.py               # 证据项/包数据模型
    │   └── merge.py                # 多来源证据标准化合并
    ├── mcp/                        # MCP 工具系统（均为占位实现）
    │   ├── types.py                # MCP 工具类型定义
    │   ├── client.py               # MCP 客户端（分发调用至各服务器）
    │   └── servers/providers/
    │       ├── mcp_web_extract_provider.py      # 网页提取（占位）
    │       ├── mcp_local_docs_provider.py       # 本地文档检索（占位）
    │       ├── mcp_filing_provider.py           # SEC 申报文件阅读（占位）
    │       └── mcp_financial_data_provider.py   # 财务指标查询（占位）
    ├── llm_planner/                # LLM 工具规划
    │   ├── models.py               # 规划数据模型
    │   ├── parser.py               # 弹性 JSON 解析
    │   └── guardrails.py           # 规划结果白名单校验
    └── rag/                        # 向量 RAG 子系统（已接线但未激活）
        ├── models.py
        ├── router.py
        ├── service.py
        ├── store.py                # Qdrant 向量数据库客户端
        ├── ingest.py               # 文档摄入管道
        └── build_index.py          # 索引构建脚本
```

## 技术栈

| 层 | 技术 |
|---|---|
| LLM | 阿里云通义千问 Qwen3-max（`ChatTongyi`） |
| 工作流引擎 | LangGraph（StateGraph，内存检查点） |
| 搜索 API | Tavily（主要）、Playwright + Bing（回退） |
| 向量数据库 | Qdrant（已编写，当前未激活） |
| 前端 | Streamlit（自定义 CSS） |
| 持久化 | SQLite |
| 嵌入 | DashScope text-embedding-v4（RAG 子系统） |

## 安装与启动

### 前置条件

- Python 3.10+
- Playwright 浏览器（用于回退搜索）：`playwright install chromium`

### 环境变量

在 `LangGraph/.env` 中配置以下密钥：

```
DASHSCOPE_API_KEY=sk-xxx              # 阿里云通义千问 API 密钥
TAVILY_API_KEY=tvly-xxx               # Tavily 搜索 API 密钥
```

### 安装依赖

```bash
pip install -r requirements.txt
```

### 启动

**Streamlit UI（推荐）：**

```bash
streamlit run LangGraph/chat_ui.py
```

**CLI 命令行模式：**

```bash
python LangGraph/Tools_using.py
```

## 项目状态

- **工作流引擎** — 完整可用，已通过 Streamlit UI 集成
- **网络搜索** — 可用，Tavily 为主提供方，Playwright/Bing 为回退
- **MCP 工具**（网页提取、文档检索、监管文件、财务指标）— **均为占位实现**，尚无实际后端
- **RAG 向量检索** — 代码已编写（Qdrant + DashScope 嵌入），但未在主工作流中激活

## 注意事项

- `LangGraph/.env` 文件中包含明文 API 密钥并已提交到仓库。建议将该文件加入 `.gitignore`，改用环境变量或其他密钥管理方案。
- 所有 LLM 提示均为中文，系统针对中文金融问答场景设计。
