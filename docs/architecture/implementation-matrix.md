# 生产级投研 Agent：实现与验收矩阵

本文件将系统目标拆成可验证的实现项。`已实现`仅表示代码、契约及自动化测试已覆盖；它不等同于已接入商业数据、已获数据许可或已部署到 AWS。

## 系统边界

| 目标 | 实现证据 | 验收方式 | 状态 |
| --- | --- | --- | --- |
| 美股投研与教育用途，不执行交易 | `packages/models` 的规划/生成约束、受控报告模板、Web 风险提示 | 黄金评测与人工合规审查 | 已实现；上线前需合规签字 |
| 运行有任务、工具、时间、成本与补证上限 | `packages/contracts` `RunBudgetSchema`；`packages/agent-runtime` | `pnpm -r test` | 已实现 |
| 运行可回放且状态追加 | `research_runs`、`run_events`、checkpoint 与 domain outbox | PostgreSQL 集成门禁 | 已实现 |
| 数据库租户关联完整性 | 追加式复合 `(id, organization_id)` 外键；消息、运行事件与运行命令 outbox 也保存直接 `organization_id`，覆盖 run、证据、报告、审计、记忆与复用证据关系 | migration 契约测试、PostgreSQL CI migration | 已实现；迁移会拒绝既有跨组织关系或孤立的历史记录，部署前须先修复该类数据 |
| TypeScript 首发运行时 | pnpm workspace，生产入口位于 `apps/api` 和 `apps/worker` | `pnpm -r check` | 已实现 |

## 对话与 Agent Runtime

| 能力 | 实现证据 | 验收方式 | 状态 |
| --- | --- | --- | --- |
| 会话、消息、OIDC/RBAC 与 SSE 重连 | `apps/api`、`packages/conversation`、`packages/live-events` | API 路由测试、OpenAPI 校验 | 已实现 |
| 投研会话生命周期与可恢复流式体验 | `ConversationStore`、会话 API、`apps/web` sidebar/transcript、SSE sequence 缓冲 | Conversation/API/Web client tests | 已实现；会话目录采用 tenant-filtered、快照一致的 keyset cursor 分页，归档可恢复、删除为不破坏审计资产的 tombstone；编辑历史问题创建新 turn；“暂停展示”不暂停 Agent 运行；已启动 run 的受控终态通过独立内部发布路径写入，不会因归档/删除而丢失审计记录 |
| 严格 HTTP 契约与最小数据披露 | `packages/contracts` public view schemas、API 投影、OpenAPI | API 路由测试、OpenAPI 校验 | 已实现；写入请求拒绝未声明字段，响应不含 tenant/创建者/摄入元数据 |
| 安全、可读的研究报告渲染 | `apps/web/app/lib/report-markdown.ts`、`ReportViewer` | Web Markdown parser 测试与 Next.js build | 已实现；仅支持受限 Markdown，原始 HTML 保持为转义文本，正式引用编号可点击读取授权证据 |
| Intent、规划、执行、Critic 子图 | `packages/agent-runtime`、`packages/models` | Runtime/模型测试、黄金评测 | 已实现 |
| 有向无环任务、并行执行、恢复限制 | `ResearchTask` 契约、Executor、checkpoint/recovery | Runtime 与 Worker 测试 | 已实现；一个原子任务恰好选择一个工具，多工具研究必须显式拆为 DAG 任务 |
| 队列安全边界的暂停/恢复 | `RunStore.pause/resume`、Run API、run event 与 transactional outbox | Runs/API/契约测试 | 已实现；仅允许 Worker 领取前的 `queued` run 暂停，恢复重新投递原始不可变 command；运行中的工具不会被用户操作强制中断 |
| 逐项证据 Claim 与服务端蕴含验证 | `packages/knowledge` citation gates、`packages/models` verifier、`packages/reports` | Citation/数值一致性测试 | 已实现 |
| 模型不能扩展可调用工具 | v2 run command manifest snapshot、`plan-policy`、`ToolRegistry` | Planner/Registry/Worker 测试 | 已实现 |

## Memory、知识与检索

| 能力 | 实现证据 | 验收方式 | 状态 |
| --- | --- | --- | --- |
| 短期、确认的长期、研究记忆分层 | `packages/memory`、`loadPrioritizedMemoryContext` | Memory 测试 | 已实现 |
| 用户偏好只允许显式确认字段 | API preference endpoints、`ConfirmedPreference` 契约 | API/Memory 测试 | 已实现 |
| 研究记忆与图谱仅作检索线索 | `ResearchMemoryHint`、Hybrid Retrieval seed、claim-evidence eligibility gate | Runtime/Hybrid Pipeline/Citation 测试 | 已实现；二者不能进入证据索引或支持 Claim |
| 删除传播、保留策略与审计 | Coordinated memory store、retention worker、删除审计 | Memory/API 测试 | 已实现；对象存储与索引实操由部署演练验证 |
| S3 证据湖、OpenSearch 混合索引、Neo4j 只读图谱 | `packages/knowledge` adapters | 单元测试与受控集成测试 | 已实现；检索命中会本地复核 tenant/许可，图谱关系须绑定有效证据 UUID；索引失败会补偿对应的 S3 与索引对象，图谱失败保留主证据等待安全重试；需配置真实 AWS/Neo4j |
| 时间匹配重排与结构化数据冲突拒答 | `rerankEvidence`、`findFinancialEvidenceConflicts`、Runtime Critic | Knowledge/Runtime 单元测试 | 已实现；时间匹配不会压过主来源，只有相同实体、期间、source-as-of、指标、币种和单位的不同数值才会拒绝相关 Claim |
| 参数化 Redshift 模板查询 | `FinancialDataTool` 与 Redshift warehouse adapter | Warehouse/tool 测试 | 已实现；生产必须注入 `REDSHIFT_SECRET_ARN`，需采购并验证数据源 |

## 工具、安全与可审计性

| 能力 | 实现证据 | 验收方式 | 状态 |
| --- | --- | --- | --- |
| 统一输入/输出 Zod 契约 | `packages/contracts`、`packages/tools` | Registry 测试 | 已实现 |
| RBAC、entitlement、超时、重试、熔断、成本与幂等 | `ToolRegistry` 与 reliability policy | Tools/Runtime 测试 | 已实现 |
| SEC allowlist、重定向/大小限制、提示注入视作不可信数据 | SEC client、ingestion、prompt-injection guards | Filing/knowledge 测试 | 已实现 |
| 逐项 SEC 披露定位 | `filing-chunks`、`SecFilingTool` 中的字符区间、摘录序号及文档 hash | Filing 工具测试 | 已实现；报告引用指向受限原始披露摘录而非整份文件 |
| 工具版本与权限的运行快照 | `ResearchRunCommand v2`、manifest snapshot、Runtime plan policy | Contracts/Tools/Worker 测试 | 已实现；v1 仅用于清空部署前队列 |
| 管理员审批的外部工具目录 | `TOOL_MANIFEST_CATALOG_JSON`、单一可信 manifest 库、启动时 catalog 绑定与 Terraform 双端 secret 校验 | Tools/Config/Worker/IaC 测试 | 已实现；catalog 只能缩紧受信任工具，禁止动态安装 |

## 发布、观测与生产运行

| 能力 | 实现证据 | 验收方式 | 状态 |
| --- | --- | --- | --- |
| SQS outbox、Worker claim、DLQ 与 EventBridge 生命周期事件 | `packages/queue`、`packages/platform-events`、Terraform | 单元测试与 `pnpm check:infra` | 已实现 |
| SEC 定时摄入部分失败可观测性 | `sec-ingestion-batch` 聚合结果与 content-free lifecycle event | Worker 单元测试、EventBridge 契约测试 | 已实现；部分失败仍以非零任务状态触发平台告警，成功 ticker 不被回滚 |
| 报告、Research Memory、消息、Run 终态、终态事件原子发布 | `PostgresResearchRunPublicationFinalizer`、Runtime publication candidate | PostgreSQL CI integration job、Runtime/DB 测试 | 已实现；Research Memory 仅在 completed 发布事务中持久化 |
| SSE 只在原子终态提交后推送 | Deferred terminal event sink | Worker 回归测试 | 已实现 |
| OpenTelemetry、成本、工具/模型审计与数值质量门 | `packages/observability`、audit stores、`packages/evaluation` numeric consistency gate | Observability/Evaluation 测试 | 已实现；需接入实际 collector/告警 |
| Docker、ECS/Fargate、迁移任务、Terraform 告警 | API/Worker 通过 `pnpm deploy --prod` 仅打包编译产物和生产依赖；Web 使用 Next.js standalone；容器均使用非 root `node` 用户，ECS 命令与部署目录一致 | `check:container`、`check:infra`、打包内容检查、CI 的三类 production image build | 已实现；真实 AWS apply 属于部署操作 |
| ECS 工作负载最小权限 | API、Worker、SEC 摄入、保留、迁移使用独立 task role 和严格分离的配置/secret map；Web 无应用 task role | `check:infra`、`check:runtime-profiles`、部署前 IAM 审计 | 已实现；部署须提供五个独立、经审核的 IAM roles |
| PostgreSQL 真实迁移和最终发布回滚 | `.github/workflows/ci.yml` 的 PostgreSQL 16 job；迁移 ECS task 使用专属 `migration_secrets`（仅 `DATABASE_URL`） | CI 执行 `verify-publication.mjs` | 已配置；本机无 Docker/PostgreSQL 时不可替代 CI 结果 |

## 发布前外部验收清单

以下项目不能由源代码或本地单元测试证明，必须在目标 AWS 账户、OIDC 租户和数据许可范围内完成：

1. 采购批准的市场数据许可、字段口径、延迟声明与 entitlement 映射。
2. Bedrock 模型、embedding 模型、OTLP collector、Secrets Manager、Parameter Store 的实际连通性与最小权限 IAM 审计。
3. RDS migration task、SQS/DLQ、Redis、S3 versioning、OpenSearch、Neo4j、Redshift 的部署后演练。
4. OIDC 真实令牌、租户隔离、管理员审计访问与删除/保留策略演练。
5. 黄金评测阈值、供应商故障演练、成本告警、恢复演练与安全/合规批准。

推荐候选版本门禁：`pnpm check`、`pnpm -r test`、`pnpm check:openapi`、`pnpm check:infra`、`pnpm check:container`、`pnpm check:ci`、`pnpm check:operations` 与 `pnpm eval:golden`。CI 额外构建 API、Worker 与 Web production image；真实 PostgreSQL 验证由 CI `postgres-integration` job 完成。
