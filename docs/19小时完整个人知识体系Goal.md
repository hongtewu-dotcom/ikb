# 19 小时完整个人知识体系 Goal

> 开始时间：2026-08-07
> 执行状态：进行中
> 工作目录：`/Users/htwu/projects/ikb`

## 目标和完成口径

这轮不是继续堆输入脚本，也不是多生成几篇 Knowledge。目标是在 19 小时执行窗口内，把 IKB 收敛成一套能持续获取、生产、维护并被本地 Agent 使用的个人知识体系。累计执行未满 15 小时，不结束 Goal；提前通过的时间用于继续消化存量欠账和做真实任务回归。

“齐全”不等于把每个原始字节都变成知识。完成口径是：当前合法可访问的来源都有登记；能读的存量已经接入，暂时受权限、登录态或限频影响的内容有游标和欠账；新增内容能增量进入；不同类型的材料按不同方法加工；Agent 能检索到证据充分、边界明确、可直接用于任务的知识，并把使用结果反馈回来。

最终验收必须同时满足四个条件：来源可追溯，知识不失真，维护能持续，真实任务能用。单独通过 doctor、lint 或 Run succeeded 都不能算完成。

## 当前基线

截至本轮开始，IKB 已有 Source、Candidate、Experience、Knowledge、Artifact 和 Ledger 分层，也已安装每日、每周维护及本地报告服务。但“数据已经很多”和“知识体系可用”之间仍有明显断点。

| 项目 | 当前状态 | 判断 |
|---|---:|---|
| Source | doctor 统计 1937 个 | 主要来自 Codex、Claude、Desk 和学城；来源覆盖表尚未闭合 |
| 学城候选 | 2022 个 | 412 已导入，936 待读，641 因历史运行环境问题阻断，32 拒绝 |
| Experience | 738 条 | 331 条被 triage 选中，但仍全部停在 queued，分析消费不足 |
| Knowledge | 22 条 | 全部为 draft；数量不是主要问题，任务消费验证和知识深度不足才是问题 |
| 人物 | 10 个关键人物批量重建 | Evidence 很多，但稳定观察、Episode 和用途视图还未形成完整闭环 |
| 维护 Run | 最近一次 8/8 Harness Case 通过 | 证明流程结构能跑，不证明知识内容好用 |

本轮已先修两个会阻断全量接入的底层问题。后台运行学城 CLI 时缺少 Node 路径，导致候选被错误标为读取失败；一个 652MB Codex 会话被一次性转成字符串，超过 JavaScript 上限。修复后，真实大文件 canary 已读出 2555 条用户/助手消息，与旧快照去重后新增 353 条，保留的原始证据从 652MB 降到 13MB，默认没有混入工具输出，doctor 仍通过。

### 本轮进展快照

截至 2026-08-07 本轮继续执行时，Agent 历史已覆盖 1459 个文件：1085 个有可见 Source，374 个确认无可见消息，真实欠账为 0；增量游标把一次全量无变化扫描压到约 12 秒。文档和评审评论已有四个私有收件箱及统一来源登记表。人物 Evidence 已对 10 个关键人物建立周期分析就绪账，数量达到门槛只表示应做语义分析，不表示人物知识可以入库。

Experience 链路已从“整段会话按关键词聚类”改为“跨历史根目录去重 → 6 小时工作 Episode → 优先级队列 → 精确证据语义 Analysis → 修订/新增/跳过/缺口分流”。真实全量 Triage 扫描 1350 个 Agent/大象 Source，形成 2133 个 Episode，其中 506 个命中分析信号；旧分段产生的记录保留为 `segmentation_superseded`，不参加聚类。首批三条真实 Analysis 形成一条修订候选、一条等待复现的新经验和一条证据缺口，没有直接写 Knowledge。独立验收 Run `run-9089af9f-538` 的 17 项测试与固定 Harness 8/8 Case 均通过；前一个 Plan 为空的 Run 仍保留 5/8 阻断记录，用于证明 `succeeded` 不等于质量通过。

当前实时账为 2051 个 Source、2024 个输入 Candidate、1795 个 Experience（506 selected，3 analyzed）和 73 张 Knowledge；personal 为 40 verified + 11 draft，work 为 22 draft。数字只表示存量和生命周期，不代表知识质量已经完成。当前只有 1 个需要立即确认的 Knowledge Candidate，其目标知识继续处于 retrieval hold。

本地 Agent 消费已跑过 coding 和 review 两类真实任务。coding canary 首轮因 Context 噪音被 5/8 阻断，相关度裁剪后 retry 8/8；review canary 连续暴露缺 plan、Artifact lineage 不完整，保留两次 blocked 记录后由第三个 Run 取得 8/8、`finalPass=true`、`recoverySucceeded=true`。由此新增了 Task scope 强隔离、Context 内容寻址 Artifact、`run plan`、完整替换稿确认 hash、revision 路径复核和 Context 自动 produced lineage。当前仍需完成文档/沟通、业务事实和人物使用 canary。

## 来源覆盖和读取边界

每个来源都要有 owner、读取方式、scope、敏感等级、存量状态、增量游标、限频、最后成功时间和未完成原因。没有这些字段，不能在报告里显示“已接入”。

| 来源 | 存量策略 | 增量策略 | 当前边界 |
|---|---|---|---|
| Codex / Claude Code / Desk | 扫描本机历史目录，按会话保留人类主消息 | 每日先比文件游标，再按记录身份导入增量；默认不读取工具输出 | 已完成 1459 个文件覆盖对账：1085 个有 Source、374 个确认无可见消息、欠账为 0；大文件流式处理，真实二次扫描约 12 秒 |
| CatPaw 远端记忆 | 分页快照后导入 | 按 memoryId 增量 | 最近快照为 2026-07-17，共 4588 条；当前进程没有插件凭证，记为待恢复，不冒充最新 |
| 学城正文与评论 | 明确 contentId 或候选池入口后只读正文、元信息、评论与回复 | 按文档修订和 commentId 增量 | 任意 30 分钟最多 10 篇；读取失败也计额度；不创建、编辑或评论 |
| 大象人物与群 | 只读取已经明确的人或群，保留消息身份和上下文 | 按时间窗、消息游标和稳定 messageId 增量 | 不做无目标全量扫描；禁止发送、回复、转发、点赞、建群或修改信息 |
| 重要文档、草稿、评审评论 | work/personal 文档与评论收件箱进入 Source，其他目录显式加入私有来源登记表 | 文件路径、修改时间、大小与内容 hash 增量 | 四个收件箱和 `source-targets.json` 已落地；空目录记为已检查，不扫描整个工作区，不把 IKB 派生产物回灌为输入 |
| IKB Run / Artifact / Feedback | 从本地账本和产物读取 | 每次 Run 结束和每次知识消费后追加 | coding/review 已有真实 Context Artifact、Verifier、Eval 和 helpful/unused 反馈；文档、业务、人物消费者仍需继续验证 |
| 项目与代码事实 | 从仓库、GitNexus 或现有 traffic-kb 按任务取证 | 代码变更后按仓库 revision 更新 | 不复制 traffic-kb；采用查询时联邦，稳定事实再进入 IKB |

工作信息只放在被 Git 忽略的 `ikb-data`，personal 和 work 继续分域。Opik、SpecX/OpenSpec 和 Multica 不进入这轮主链路。外部系统全部只读，未经明确授权不 push、不发消息、不发布文档。

## 获取、生产和维护循环

日循环负责“发现变化并形成可分析输入”。顺序是来源盘点检查、增量 intake、原始证据去重、Session Triage、输入候选发现、限频读取、人物 Evidence 更新、结构门禁、doctor、Ledger 和报告。某一步失败时，后续依赖步骤不得用 succeeded 掩盖；游标只能在本步证据落盘并通过完整性检查后推进。

周循环负责“把重复经验变成稳定知识”。被 triage 选中的 Episode 先生成 Experience Record，不直接生成 Knowledge；Analyst 用精确记录引用写 `candidate/skip/gap`。新模式需要三个独立 Agent Run，或两个独立 Run 加一次绑定当前 Analysis 与已校验 Artifact 的真实验证，才能形成 Knowledge Candidate；同一会话内按时间切出的多个 Episode 仍只算一个 Run，普通维护 Run 通过也不算内容验证。对现有 Knowledge 的直接反例走 `revise/retire` 待复核候选，不再新增一张相互冲突的卡。人物按 dossier → Episode → 周期蒸馏运行，单次发现只追加证据，不直接重建人物结论。周循环还检查知识冲突、过期、supersede、retire 和反馈聚类。

任务循环负责“证明知识能用”。Agent 先建立非空 DAG plan，再 search，并按需 get Knowledge、Source Context 或 Context Pack。Context 强制继承 Task scope，每个内容版本自动形成带 hash 的 Artifact；任务完成后回传 helpful、partial、incorrect 或 unused。partial/incorrect 先进入 Experience 和修订候选，不直接覆盖正式知识。至少用业务事实包、流程执行卡、人物/写作沟通三类任务做 canary，检查事实覆盖、引用可打开性、返工和边界。

## 类型化知识产物

不同类型不能共用“一篇材料压成一句总结”的抽取方式。业务材料先保留对象、关系、流程、状态、规则、异常、数据口径、决策依据和未确定项，再按使用场景生成视图；方法论只能作为事实包之上的派生层，不能替代原知识。

| 类型 | 要保留的主体 | 最终消费形态 |
|---|---|---|
| 业务事实 / 概念 | 定义、对象关系、规则、例外、时态、来源 | Domain Pack、Fact Card |
| 架构 / 流程 / 入口 | 节点、上下游、状态、接口、失败路径、版本 | Architecture Map、Flow Card |
| 决策 | 背景、选项、依据、选择、代价、复议条件 | Decision Card |
| 操作与排查 | 前置条件、步骤、观测、失败处理、退出条件 | Playbook、Troubleshooting Card |
| 项目 / Goal | 目标、指标、owner、依赖、里程碑、当前状态 | Project Card |
| 写作 / 评审 / 沟通 | 原文模式、评论、适用场景、反例、可复用动作 | Review/Writing/Communication Guide |
| Agent 经验 | 触发、尝试、失败、修复、Verifier、复现条件 | Experience Record，满足重复证据后再晋升 |
| 人物 | 身份、Episode、稳定观察、反证、场景和用途 | Dossier 加写作、沟通、评审、决策、协作等用途视图 |

所有正式 Knowledge 必须有证据链、适用范围、边界、使用契约、验证路径、置信度依据和时间状态。人物稳定结论必须有独立 Episode、跨日期或跨来源支持，并保留反证；业务逻辑可以先以有边界的 draft 存在，不要求和人物使用同一置信度门槛。

## 19 小时执行拆分

| 时间段 | 工作 | 完成门禁 |
|---|---|---|
| 0–1 小时 | 冻结当前数据与架构基线，盘点来源、适配器、维护任务和 Agent 接口 | 来源矩阵可逐项对账；未接入项不能写成已完成 |
| 1–4.5 小时 | 修复存量导入阻断，执行可恢复的本地存量接入，建立 backlog、游标和容量账 | 大文件、重复、失败恢复和 raw 完整性均有真实证据；不触发外部高频读取 |
| 4.5–7 小时 | 收敛每日、每周、保鲜和人物循环 | 每步有输入、输出、消费者、门禁和重试位置；限频是代码门禁 |
| 7–10 小时 | 跑通类型化分析与 Curator | Experience 不直接冒充 Knowledge；至少形成几类完整事实包和候选 |
| 10–12 小时 | 提供本地 Agent 的 search、get、Context Pack 和 feedback 入口 | 在其他工作目录也能调用；默认渐进加载，不注入全部知识 |
| 12–15 小时 | 跑三类真实任务 canary | 每个 canary 有输入引用、产物、Verifier 和反馈；内容质量可人工评审 |
| 15–17 小时 | 继续消化存量欠账，做跨来源聚合、失真检查、人物反证和增量恢复验证 | 不以“已有产物”为终点；抽样追到原始证据，修掉重复、过度抽象和失真 |
| 17–19 小时 | 修复回归、跑全门禁、更新报告和运行手册 | check、lint、extraction validate/verify、doctor、ledger 和 Harness Eval 全部通过 |

执行顺序可以因真实故障调整，但不能跳过最终消费者。遇到学城或大象限频时，保留 backlog 和 nextEligibleAt，继续做本地分析与维护，不用密集重试消耗额度。

## 用户能看到和需要决策的内容

本地 HTML/Markdown 报告实时展示八类信息：各来源覆盖率与欠账、最近一次增量、限频额度与下次可读时间、Experience 消费进度、Knowledge 状态与保鲜期、人物 Episode 与稳定观察、失败/重试、真实任务 canary 结果。

系统先把能由证据和规则判断的事项处理完，只把会改变业务口径、人物稳定结论、外部副作用或正式知识状态的事项交给用户。待确认文件必须用中文标题，正文直接写“确认什么、为什么要确认、采用后怎么用、不确认会怎样”，并附可打开的 Knowledge、Source 和 Artifact 引用。

对于 Knowledge 修订，用户确认的对象必须是完整替换稿，不是“同意这个方向”一句话。接受时 Core 保存该文件的不可变快照和 SHA-256；后续应用只能使用完全相同的字节。当前待确认项是记忆治理规则修订：接受会修订 `kb-9d016efb-2ae` 并合并退役 `kb-da1d8fb4-aea`，不确认则两张旧卡继续暂停 Agent 召回，候选也不会写入 Vault。

## 本轮交付

本轮结束时应留下代码、真实数据和运行证据，而不只是一份设计文档：来源覆盖账、存量与增量运行记录、类型化知识产物、人物周期蒸馏结果、本地 Agent 接入 Skill/CLI、三类 canary、实时报告、维护手册和未完成 backlog。历史证据不删除；错误知识通过 revision、supersede 或 retire 维护，旧版本仍可追溯。

未经用户明确指令，本轮不提交、不推送。若 19 小时结束时仍有权限或限频阻断，交付中必须写清剩余数量、最后游标、阻断原因和继续执行命令，不能用“基本完成”替代事实。
