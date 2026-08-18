# 本地完成审计与部署后验收边界

**审计范围：** 将生产级投研 Agent 的设计转化为本地 TypeScript 工程、版本化契约、自动化质量门与可运行的开发适配器。本文不把缺少目标云账户、企业 IdP 或商业数据许可误报为代码缺失。

## 结论

本仓库已实现并在本地/CI 可验证以下能力：模块化 TypeScript 全栈、受限 Agent Runtime、分层 Memory、混合知识与 RAG 边界、受控工具、逐项引用、会话式产品体验、审计/观测/评测契约，以及可部署的基础设施定义。

以下不是“待设计”事项，而是**需要目标环境才能完成的验收活动**：AWS 资源实际创建、企业 OIDC 真实令牌、Bedrock 与商业数据供应商连通性、数据许可口径、IAM 审计、灾难恢复和合规签字。它们不应在没有账号、秘密、批准数据源或授权主体的本地机器上伪造。

## Phase 1：系统架构设计

| 原始要求 | 本地实现证据 | 本地验收 |
| --- | --- | --- |
| Conversation → Runtime → Planner/Executor/Critic → Tools → Knowledge → Evaluation 的生产边界 | [system-design.md](system-design.md)、`apps/*` 与 `packages/*` workspace 分层 | 架构审查、TypeScript workspace check |
| TypeScript 首发，Python 原型不进入生产路径 | `legacy/python-prototype` 隔离；API/Worker/Runtime 为 TypeScript | `pnpm check` |
| 长期演进、DI、替换 LLM/DB/Embedding/Retriever | package 接口、Zod contracts、生产 composition root | 单元/契约测试 |
| 数据、成本、工具、时间、反思上限 | `RunBudgetSchema`、Runtime policy、ToolRegistry | Runtime/Tool 测试 |

## Phase 2：基础工程与会话产品

| 原始要求 | 本地实现证据 | 本地验收 |
| --- | --- | --- |
| pnpm workspace、API、Web、Worker、配置、日志、OpenAPI | 根 workspace、`apps/api`、`apps/web`、`apps/worker`、`packages/config`、`docs/openapi/v1.json` | `pnpm check`、`pnpm check:openapi` |
| 可复现的本地配置启动 | `packages/config/src/local-environment.ts`；所有 API/Worker 可执行入口在加载配置前调用它 | Config 单元测试；开发环境读取最近的 `.env`，且不覆盖 shell 变量；生产环境拒绝读取本地文件 |
| 会话新建、读取、重命名、归档、恢复、软删除与分页 | `packages/conversation`、`apps/web/app/components/conversation-sidebar.tsx` | Conversation/API/Web 测试 |
| 流式输出与断线恢复 | `packages/live-events`、SSE API、`sse-frame-parser.ts` | SSE parser/API tests |
| 修改历史问题且保留审计 | `conversation-transcript.tsx`、不可变 `ResearchRun` | Conversation/Runtime tests |
| 会话暂停 | 浏览器“暂停展示”缓冲；创建流式 turn 返回的服务端 `x-research-run-id` 使 UI 可在 Worker 领取前调用 queued `pause/resume` | Run recovery/API/Web client 契约测试；运行中强停有意不实现 |
| 产品交互、引用与错误表达 | [research-workbench.md](../product/research-workbench.md)、Evidence Drawer、受限报告渲染、历史会话按 run ID 恢复正式报告 | Web tests + Next.js build |

## Phase 3：Agent Runtime

| 原始要求 | 本地实现证据 | 本地验收 |
| --- | --- | --- |
| Intent、Planner、Executor、Reflection/Critic | `packages/agent-runtime`、`packages/models` | Runtime 与 golden tests |
| 任务 DAG、有限并行、失败恢复 | task contracts、checkpoint/recovery、Worker handler | Runtime/Worker tests |
| 不可变 run、执行与发布审计 | `packages/runs`、`packages/db` publication finalizer、outbox | DB/runtime tests |
| 无证据时部分回答或拒答 | critic/citation gates、controlled report composer | Citation/evaluation tests |

## Phase 4：Memory 与 Knowledge

| 原始要求 | 本地实现证据 | 本地验收 |
| --- | --- | --- |
| 短期、确认长期、研究记忆及 `MemoryStore` CRUD | `packages/memory`、preference API、coordinated deletion | Memory/API tests |
| 向量、关键词、图谱和仓库的可替换接口 | `packages/knowledge` OpenSearch/Neo4j/Redshift/S3 adapters | Knowledge adapter tests |
| Hybrid RAG、时间/权限/来源过滤 | query expansion、reranking、context builder、citation gates | Knowledge/Runtime tests |
| 证据版本、删除传播与审计 | evidence lake/index/graph cleanup contracts、retention worker | Memory/knowledge tests |

## Phase 5：Tool System

| 原始要求 | 本地实现证据 | 本地验收 |
| --- | --- | --- |
| 统一 Tool/Manifest/Registry 契约 | `packages/tools`、`packages/contracts` | Registry tests |
| Filing、Financial、Retrieval、Graph、Analysis、Report 能力 | 受控 provider adapters 与 deterministic analysis/report modules | Tool and formula tests |
| 动态目录、授权、限流、重试、熔断、日志 | approved catalog、RBAC/entitlement、reliability policy、audit store | Tools/Worker tests |
| Prompt injection/SSRF/供应商失败处理 | SEC allowlist、输入净化、公开错误边界 | Filing/knowledge tests |

## Phase 6：RAG 与报告

| 原始要求 | 本地实现证据 | 本地验收 |
| --- | --- | --- |
| Query understanding/expansion → hybrid retrieval → rerank → context | `packages/knowledge` retrieval pipeline | Knowledge tests |
| Claim 绑定证据、服务端蕴含/数值/时点校验 | contracts、citation verifier、critic | Citation and numeric tests |
| 流式草稿与正式报告分离 | `StreamingClaims`、`ReportViewer`、report store | Web/report tests |
| 可点击、授权、可定位引用 | citation index、evidence drawer、HTTP(S) URL contract | Contracts/Web tests |

## Phase 7：生产能力的本地可交付部分

| 原始要求 | 本地实现证据 | 本地验收 |
| --- | --- | --- |
| 可观测性、成本和评测 | `packages/observability`、`packages/evaluation`、golden set | `pnpm eval:golden` |
| 队列、DLQ、outbox、容器、IaC、运行手册 | queue/platform events、Dockerfile、`infra/terraform`、runbook | infra/container/CI/operations validators |
| 发布质量门 | root scripts、GitHub Actions | 本地 scripts + CI PostgreSQL job |

## 必须在部署后完成的验收（暂缓，不阻塞本地实现）

1. 配置经采购批准的市场数据、新闻/研报、EDGAR 身份与字段许可，并核对延迟、币种、单位和 entitlement 映射。
2. 用企业 OIDC 的真实 JWT 验证组织隔离、角色、撤销和管理员审计访问。
3. 用目标 AWS 账户验证 Bedrock、Secrets Manager/Parameter Store、RDS、SQS/DLQ、Redis、S3、OpenSearch、Neo4j 和 Redshift 的连通性与最小 IAM 权限。
4. 执行迁移、备份/恢复、供应商故障、DLQ 重放、成本告警、数据删除传播与灾难恢复演练。
5. 以内部黄金集确定上线阈值，并取得安全、合规和数据许可签字。

这些活动的操作顺序和责任分界见 [production-runbook.md](../operations/production-runbook.md)。
