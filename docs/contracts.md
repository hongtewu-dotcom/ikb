# ikb 执行与治理契约

## 契约先于实现

系统能否长期运行，取决于每个环节是否说清输入、输出、副作用、证据和失败出口。Agent 可以更换模型，Skill 可以升级实现，控制面可以改界面，但这些契约不能随 prompt 漂移。

## 核心对象

### Source

Source 是外部材料的可追溯入口，不等同于 Knowledge。首批 source kind 为 `elephant`、`ai_conversation`、`document`、`review_comment`、`artifact` 和 `manual`。每条 Source 必须有稳定 `source_id`、scope、sensitivity、locator、raw hash 和 normalized-records hash；消息、文档版本、评论和运行产物必须保留原始定位。

重要文档的草稿、版本差异、评审评论、处理理由和最终产物都属于输入。Agent 会话中的用户目标、工具调用、失败修正和最终验证同样属于输入。分析可以生成候选，但不能绕过证据引用和人工门禁直接晋升 verified。

### Knowledge

```yaml
id: kb-20260715-001
type: fact
collection: people
source_kind: document
scope: work
sensitivity: work-internal
status: draft
title: 示例知识
source_refs:
  - source-id
valid_from: 2026-07-15
review_after: 2026-10-15
tags:
  - example
aliases:
  - kb-20260715-001
related: []
derived_from: []
contradicts: []
quality_version: 1
admission_reason: 这条结论会影响后续评审判断
applicability: 适用于有可复现证据的评审结论
boundary: 未验证的单条评论不能直接泛化
confidence: medium
confidence_basis:
  - 两个独立 Source 支持同一结论
temporal_state: current
verification: unverified
```

`type` 表示知识语义，首批为 `fact / decision / preference / playbook / entity / goal`；`collection` 表示 Vault 中的人类浏览位置，首批为 `domains / projects / people / concepts / decisions / playbooks / lessons / syntheses`。二者正交：同一个 `fact` 可以按对象进入 `people`、`projects` 或 `concepts`。没有显式 collection 时 Core 只做保守映射，Curator 应主动选择。

`confidence` 表示证据强度，不是概率，也不等于 `status`：`low` 允许作为带边界的探索性 draft，`medium` 表示来源支持但仍需任务验证，`high` 表示多来源或强来源已相互印证。`confidence_basis` 必须说明为什么落在这个等级。`temporal_state` 描述内容是当前、规划、历史、混合、已被替代还是未知；`verification` 描述是否只完成来源确认、已被真实 Task 验证或得到用户确认。业务逻辑可以先以 medium/low draft 进入 Context 候选，人物归因默认要求 high identity confidence 与至少 medium pattern confidence；两者不能用一套阈值。

`collection: people` 且 `quality_version >= 2` 的人物卡还必须写 `identity_confidence`、`pattern_confidence` 和 `independent_episode_count`。代码门禁要求身份为 `high`、模式至少为 `medium`、独立 Episode 至少 2 个；人物要变成 `verified`，还必须有 `task_validated` 或 `user_confirmed`。所以“身份匹配准确”不等于“已经形成稳定人物模式”。

知识抽取不采用“全文摘要”作为默认产物，而采用 Knowledge Card：结论、证据链、推导/原因、适用条件、执行步骤或决策分支、例外与不适用、验证方法、当前未知项。正文可以短，但这些字段不能被摘要省略；细节过长时放在 Analysis Artifact，Knowledge 通过 `source_refs` 和 Artifact 链回去。

知识策展没有“每篇文章至少一条”的产量指标。每个已分析来源必须明确选择：`admit` 表示形成了会影响未来判断或行动的可复用结论；`skip` 表示只有临时状态、重复信息、无依据观点或与现有知识相比没有新增价值。`skip` 通过 `knowledge skip` 写入 `kind=knowledge / status=rejected` 的 Candidate 和账本事件，不创建 Vault Markdown；重复执行保持同一候选，不重复记账。

来源型 Knowledge（大象、Agent 对话、文档、评论和 Artifact）在落盘前必须同时具备 `source_refs`、`admission_reason`、`applicability` 和 `boundary`。正文为空、普通正文含字面量 `\n`/`\r\n`、缺少上述字段时，capture/ingest 在写文件前拒绝；`knowledge lint` 和 `doctor` 会检查手工编辑造成的同类问题并返回非零退出码。代码块和行内代码中的 `\n` 只是语法样例，不报错。旧版 `quality_version=0` 知识仍可读取，但来源型旧 draft 在补齐当前准入字段前不能 verified。

verified 必须有可访问来源或明确的人工确认记录；变更结论时追加 revision，不覆盖历史；敏感等级只能保持或升高，自动流程不得降低。关系字段使用 Obsidian `[[knowledge-id]]`，`related` 与 `contradicts` 双向维护，`derived_from` 从新知识指向依据；跨 personal/work Vault 默认拒绝，必须显式确认。关系变更追加 `knowledge.related` 事件。`index.md` 与 governance 状态是可重建视图，不是 Knowledge，不得进入 search、review 或关系操作。

### Input Candidate

Input Candidate 是外部入口的待处理记录，不是 Source，也不是 Knowledge。它把“从哪里发现”“要读什么”“当前是否允许读取”和“读取后落了哪些 Source”固定下来，避免 Agent 在临时上下文中直接追链接。

```yaml
id: cand-20260717-001
kind: citadel_document
status: discovered
scope: work
sensitivity: work-internal
locator:
  adapter: citadel
  content_id: "123"
  url: https://km.sankuai.com/page/123
origin:
  source_ids: [src-codex-001]
  record_ids: [src-codex-001:session:r7]
resolution: null
```

候选状态是 `discovered → queued → ingested`，也可以回到 `discovered`（暂停排队）或进入 `rejected` / `blocked`。状态变更和每次新增来源/record 都追加候选快照与 `candidate.*` 账本事件。`discovered` 只表示找到了入口；手工 `candidate resolve` 仍要求先 `queued`，而用户授权的维护流程可以通过 `candidate resolve-all` 自动排队并读取当前 scope 下候选。学城读取采用滚动限频：任意 30 分钟最多 10 篇，文档间隔默认 2 秒，剩余候选留在池中；`--limit` 只限制本次最多处理数，`--limit 0` 也不能绕过 30 分钟窗口。每次实际发起读取前追加 `candidate.resolve_started` 事件，失败也计入窗口。当前首个外部候选适配器是学城：`source search-citadel` 保存搜索原始响应并可写入候选池，`candidate discover <source-id>` 从已导入 Source 的学城 URL/`contentId:` refs 中发现候选，`candidate resolve`/`candidate resolve-all` 再调用官方 `oa-skills citadel` 读取正文、元信息和评论。解析后的正文与评论分别进入 `document` / `review_comment` Source；权限或密级导致的读取失败进入 `blocked` 并记录原因，候选不会自动变成 verified Knowledge。所有学城动作均为只读，不创建、编辑、评论或发送消息。

### Key Person Directory

关键人物目录是本地私有的身份元数据，不是 Knowledge，也不自动授权跨来源扫描。每项包含 `id`、可选 `mis`/`uid`/`name`、`aliases`、`scope`、`enabled`、`createdAt` 和 `updatedAt`；默认 `scope` 为 `work`。目录文件为 `ikb-data/entities/people/key-people.json`，目录 0700、文件 0600，且不进入 Git。

`people add`、`people update` 与 `people remove` 先更新目录，再追加不可变的 `person.added` / `person.updated` / `person.removed` 事件；`people view` 与 `people rebuild` 生成可重建的人物投影，并追加 `person.view_built` 事件。`doctor` 必须能够校验这些事件链。目录只维护“查谁”的名单，人物视图只按明确身份字段和显式关联聚合 Source；形成正式知识时仍需保留原始 Source 引用。

人物处理分为四层，不能把它们混成一次写入：

1. **Source delta**：每次同步只追加不可变 Source 或增量 Source；不改人物页，不生成 Knowledge。
2. **Evidence dossier**：在 intake 批次结束、每日计划或明确查询时，对受影响 scope 做一次确定性全量投影；重复执行得到同一组证据（生成时间和账本事件除外）。`context`/共现只能作为协作上下文，不能证明此人表达过观点。
3. **Person consolidation**：默认按周运行；出现至少 3 个新增 direct Episode、2 个独立新 Source、身份映射变更或用户明确要求时提前运行。它读取当前 dossier 和上一版 Artifact，输出 `added / unchanged / superseded / conflicted / unknown`，不静默覆盖历史。
4. **Knowledge draft**：只有通过身份、独立 Episode、可行动性、时间有效性、推断边界和 Trace 六道门禁的原子结论，才由 Curator 写入 `people` collection 的 draft；没有满足条件时保留证据并输出空候选。verified 仍需要人工确认或真实任务验证。

这意味着“发现一条消息”与“重建人物投影”以及“形成一条人物知识”是三个不同的事件，不能用消息数、群参与、被 @ 或摘要长度代替准入。

### Task

| 字段 | 含义 |
|---|---|
| id / title | 稳定标识和标题 |
| goal | 要改变什么结果 |
| acceptance | 如何判断完成 |
| type | coding、review、cr、document、communication、upward-management 等 |
| priority | 优先级 |
| status | open、active、waiting、done、canceled |
| risk | low、medium、high、critical |
| agent_id / skill_ids | 负责 Agent 和允许使用的 Skills |
| knowledge_query | 组装上下文的检索意图 |
| external_refs | Git、ONES、学城、CR 等外部对象 |

Task 状态表达业务动作：open 尚未开始，active 正在推进，waiting 等待人工或外部条件，done 已通过验收，canceled 明确终止。具体步骤状态留在 Run，不向 Task 状态继续加词。

### Run

Run 表示一次可重放的执行尝试，状态为 queued、running、awaiting_approval、succeeded、failed、canceled。

每个 Run 必须保存：

- 输入快照与 Task 版本。
- context pack 及引用的知识 ID。
- Agent、模型/运行时和 Skill 版本。
- 计划、步骤事件、工具调用摘要和失败记录。
- 产物、质量检查、人工决定和最终验证。
- 下一次恢复所需的 checkpoint。

### Agent Manifest

| 字段 | 契约 |
|---|---|
| id / role | 稳定角色和职责 |
| accepts | 可处理的 Task 类型 |
| required_context | 必须加载的知识类型 |
| skills | 允许调用的 Skill 白名单 |
| runtime | manual、codex、claude、catpaw 等 adapter |
| output_schema | 结构化输出契约 |
| gates | 完成前必须通过的检查 |
| fallback | runtime 不可用或失败时的出口 |

首批采用六个逻辑角色，不按每一种工作类型各建一个常驻 Agent：

1. `ikb-harness`：执行编排、单次 Run 复盘、跨 Task 模式发现、改进建议以及 Approval/恢复。
2. `ikb-intake`：采集并保存 Source，只负责证据归档，不负责下结论。
3. `ikb-analyst`：从 Source 中提取事实、决策、人物、问题、冲突和未知项。
4. `ikb-curator`：把有证据的分析整理成 Obsidian draft、关系和复核项。
5. `ikb-operator`：执行编码、评审、CR、文档、沟通草稿和向上管理等工作 Skill。
6. `ikb-verifier`：按验收条件、证据和风险检查产物，输出通过或阻断结论。

`coding`、`review`、`cr`、`document`、`elephant-draft` 和 `upward-management` 是
`ikb-operator` 的 Skill，不再分别复制 Agent 的状态、权限和账本。用户本人是高风险动作的最终批准者，不计入 Agent 角色。

## 角色门禁矩阵

门禁是角色契约的一部分。每个角色都必须声明进入条件、允许动作、必交产物和退出条件；缺少任一必交产物时只能进入 `blocked`、`waiting` 或保留为 `draft`，不能由 prompt 自行放行。

| 角色 | 绑定门禁 | 进入门禁 | 允许动作 | 必交产物 | 退出门禁 |
|---|---|---|---|---|---|
| `ikb-harness` | G0/G4/G5/G6 | Task 有目标、验收、scope、risk；Run 有明确 Agent/Skill | 建 Run、组 Context Pack、调度步骤、申请 Approval、记录 checkpoint | plan、context pack、步骤事件 | 所有步骤有状态；高风险动作已申请 Approval；失败有原因和恢复出口 |
| `ikb-intake` | G0/G1 | 来源在授权范围内；时间范围和数据 scope 明确；连接器凭证有效 | 读取来源、保存原文、标准化、去重、登记 Source | raw 快照、records、source 元数据、hash、ingest 事件 | Source 完整性通过；无法定位或无法确认范围的材料进入 `blocked` |
| `ikb-analyst` | G1/G2 | Source 可读取且完整；分析目的、人物/主题和时间范围明确 | 提取事实、决策、问题、人物、冲突和未知项 | analysis Artifact；每个结论都有 evidence refs | 无来源的结论只能是候选；证据冲突或身份不确定必须列入 unresolved |
| `ikb-curator` | G2/G3 | 分析 Artifact 有证据；目标 scope/sensitivity 已确定 | 对每个来源选择 admit/skip；写 Knowledge draft、选择 type/collection、建立有依据的 Obsidian 关系 | admit：draft、准入字段、source_refs、relations；skip：rejected Candidate 和 reason | 来源型 draft 缺准入字段不得落盘；无 `source_refs` 不得 `verified`；跨 scope 关系必须显式确认 |
| `ikb-operator` | G4/G5/G6 | Task 已 active；Context Pack 已生成；允许的 Skill 与副作用等级匹配 | 编码、评审、写作、生成沟通草稿、本地可逆修改 | diff/文档草稿/CR 报告/测试报告等 Artifact | 验收证据齐全；L3/L4 动作不能直接执行，必须转 Approval |
| `ikb-verifier` | G1/G2/G3/G6 | Task acceptance、相关 Source/Knowledge 和 Artifact 均可访问 | 检查事实、测试、风险、隐私、完整性和验收条件 | verification Artifact；pass/block 结论及理由 | 只有通过验证的 Run 才能成功；阻断必须说明缺口和下一步 |

## 全局门禁编号

角色矩阵中的条件统一使用以下编号，便于 CLI、Skill 和未来界面显示同一套状态：

| 编号 | 门禁 | 判定 |
|---|---|---|
| G0 | 边界与授权 | scope、sensitivity、身份、时间范围和连接器权限不越界 |
| G1 | 存证与完整性 | 原文、标准化记录、来源元数据、hash 和事件账本可互相校验 |
| G2 | 证据 | 分析结论能回到 Source record、文档版本、评论位置、Artifact 或人工确认 |
| G3 | 知识准入 | 分析结果明确 admit/skip；来源型 Knowledge 具备来源、准入理由、适用范围和边界；verified 必须有 source_refs |
| G4 | 执行准备 | Task 目标/验收、Run、Context Pack、Agent/Skill 白名单齐全 |
| G5 | 副作用审批 | push、CR 评论、ONES 更新、大象发送等 L3 动作必须绑定准确的 Approval |
| G6 | 验收与闭环 | Artifact、测试/验证结果、状态事件、失败原因和下一步均可追溯 |

### 当前代码硬门禁与待补门禁

当前已经由 Core 代码硬性拦截的包括：Source scope 校验、原文/records hash 和路径完整性、重复 Source 跳过、增量 Source 的稳定记录去重与 state 校验、来源型 Knowledge 落盘准入、普通正文的字面量换行转义、Knowledge `verified` 必须有 `source_refs`、跨 scope 关系默认阻断、Task/Run 状态机、Approval 等待期间不能成功、事件账本 hash 链和 `doctor` 检查。Harness 的 `harness-events.v1` 只允许引用/枚举/hash，拒绝 raw content/path/url；`harness-eval.v1` 的 12 个合成 Case、本地 run-quality projection 和 Outer 的 evaluation failure 聚类也已有代码与测试。无可复用结论时，`knowledge skip` 会留下幂等的 rejected Candidate 和事件，不生成 Knowledge 文件。

角色的 Run 启动 Agent/Task 类型/Skill 白名单已经由 CLI 校验；以下仍是 Skill 或人工约束，尚未统一代码拦截：对象级读写权限、最少/独立证据数、自动重复与冲突检测、Context Pack 必须存在、high/critical 风险自动发起 Approval、Task 完成必须绑定 Artifact、统一的 verifier 通过状态。后续实现门禁命令时必须优先补齐这些项，不能把它们继续留在 prompt 里。

### `ikb-harness` 的职责边界

`ikb-harness` 是 Harness Agent，不只是一个顺序调度器。它同时负责“让当前 Task 收敛”和“从历史 Run 中发现流程改进”，但不替代 `ikb-analyst` 对业务内容的证据分析。

| Harness 模式 | 分析对象 | 主要动作 | 输出 |
|---|---|---|---|
| 执行编排 | 当前 Task/Run | 拆步骤、组 Context Pack、选择角色/Skill、推进状态、处理失败和 Approval | plan、handoff、checkpoint、gate 结果 |
| 单次复盘 | 单个 Run | 分析阻断、失败、人工修改、缺失证据、重复步骤和恢复成本 | run review、缺口、下一步 Task |
| 跨 Task 改进 | 多个已结束 Run | 聚类重复失败、知识缺口、Skill 低效、门禁误阻断和可复用模式 | pattern candidate、skill/gate 改进建议、Plan Pack 候选 |

Harness 的改进建议必须引用真实的 Task/Run/Artifact/Approval 事件，不能根据一次偶然输出直接改规则。涉及角色权限、状态语义、数据契约或外部副作用的建议只能进入 Plan Pack 和人工批准，不能由 Harness 自我修改。

### Session Triage 与 Experience Record

Source intake 和语义深读不是同一个门槛。每日增量同步只负责把已授权的 Claude/Codex/Desk/Elephant 输入保存为不可变 Source；随后 `experience triage` 做确定性筛选，默认只读取 normalized 的 user/assistant/人类发言，不读取完整 tool output。命中以下任一信号才进入 Experience 队列：

- 失败、阻断、重试或恢复；
- 人工纠偏、反复改方向或明确指出失真；
- Verifier/验收/质量门禁驳回；
- 非显然修复、根因、兼容、回归或边界补强；
- 账本中 Knowledge feedback 为 `partial`/`incorrect`；
- 新的决策、规则、约束或停止条件。

Experience Record 只保存信号计数、Source/record/event/Run 引用、时间和状态，不保存原始长文本，也不直接生成 Knowledge。无信号的会话不进入队列；没有明确 Source→Run 交接的会话可以分析，但不能被当成独立 Run 晋级。人物 dossier 仍按 intake checkpoint/每日视图重建，人物 Knowledge 仍需独立 Episode 和身份门禁。

每周聚类只允许两种确定性晋级条件：同一模式有至少 3 个独立 Run，或至少 2 个独立 Run 且有一次真实 `verification_completed`/`evaluation_completed=result=pass`。满足后生成 `ikb-knowledge-candidate.v1`，状态固定为 `pending_review`，claim、适用范围、边界、使用契约、验证计划、置信度和时间状态保持待分析，交给 Analyst/Curator 和人工确认。候选不是 Knowledge，不能被 Context Pack 当作可执行规则；只有补齐完整 Knowledge Card 并走现有 admit/verify 门禁后才可进入 Vault。

对应命令：

```bash
./bin/ikb experience triage --scope work --adapter all --limit 500
./bin/ikb experience list --scope work
./bin/ikb experience cluster --scope work --min-samples 3
./bin/ikb experience candidate-list --scope work
```

### 全局推理与确认项压缩

Experience、候选和 Knowledge 的数量都不是用户待办。每轮分析先执行 `reasoning`，将已有 Draft 的确认项按确定性原则分成三类：`auto_resolved`（已有边界可自动采用）、`defer_until_task`（需要最新配置/SOP/日志/真实验证，绑定到具体 Task）、`ask_user`（人物身份与稳定观察、高风险规则/Approval/门禁、外部副作用或证据无法推出的组织选择）。系统保留逐条问题和证据引用，但只把 `ask_user` 按人物/政策合并成决策包。

```bash
./bin/ikb reasoning run --scope work --json
./bin/ikb reasoning show --scope work --json
```

报告写入 `ikb-data/governance/<scope>/reasoning/` 并追加 `reasoning.generated` 账本事件；它不改变 Knowledge 的 draft/verified/retired 状态，也不代表用户已经批准规则。HTML 观测页只展示输入覆盖、三类处置数量和压缩后的决策包。任何外部写入仍须独立 Approval，普通证据缺口不升级为即时询问。

Harness 的过程分析与 `ikb-analyst` 的内容分析分工如下：

- `ikb-analyst` 回答“证据说明了什么”；
- `ikb-harness` 回答“我们的工作过程哪里反复失败，下一轮怎样更好”；
- `ikb-verifier` 回答“本次结果是否满足验收和安全条件”。

v0.1 当前已经落地角色 manifest、中文名/稳定 ID、门禁目录、Run 启动时的角色/Task 类型/Skill 白名单校验、Task/Run/Approval/Artifact 账本、结构化 Harness 事件写入、确定性评估和只读 Outer 聚类。自动节点交接/并行编排和真实工作流的全自动调度仍属于后续 runtime；当前交接和循环事件由 Harness/Skill 显式写入，不能伪装成已经自动编排。

### Skill 使用契约

Skill 是 Agent 面向 Source Plane 和 Knowledge Plane 的主要入口，CLI 只承担确定性底座和运维操作。Skill 输入至少声明 source kind、scope、时间范围、人物/主题、分析目的和副作用等级；输出至少包含报告、evidence refs、candidate knowledge、unknowns 和 next action。Skill 不直接修改 verified 知识，不绕过 ledger，不执行未声明的外部副作用。

### Skill Manifest

每个 Skill 必须声明：

- 输入 schema、输出 schema 和错误 schema。
- 是否只读，是否写本地，是否写外部系统。
- 所需凭证引用和允许访问的数据范围。
- 幂等键、超时、重试策略和回滚方式。
- 成功验证方式以及产出的证据。

Skill 只做原子能力，不负责完整任务编排。Agent 不能调用 manifest 未声明的 Skill，Skill 不能自己扩大数据范围或权限。

## Harness 三循环

三循环都由 `ikb-harness` 负责流程侧编排；内容判断仍交给对应的 Analyst、Curator、Operator 和 Verifier。相同的稳定角色 ID 可以在不同模式下创建不同 Run，不复制一套新的 Agent 状态。

## Loop 数据契约

三层 Loop 的输入和输出必须是可定位的数据，不允许只存在于 prompt 或临时对话中。机器可读版本可通过 `./bin/ikb loop list|show <inner|mid|outer>` 查看。

| Loop | 必须输入 | 必须输出 | 证据来源 | 当前状态 |
|---|---|---|---|---|
| INNER 知识收敛 | `source_refs`、分析问题、scope/sensitivity、时间或 revision 边界；人物/主题和已有知识按场景提供 | Analysis Artifact、findings、evidence_refs、unknowns/conflicts、candidate_knowledge、G0～G3 结果 | `ikb-data/sources/<source-id>/`、Source events、Knowledge Markdown、Analysis Artifact | 部分落地，可手工收敛 |
| MID 任务执行 | Task contract、角色/Skill manifest、Context Pack、plan/checkpoint、风险和 scope；重试时附历史 Run | handoff events、Run Artifact、Approval 记录、verification 结果、Knowledge references、G4～G6 结果 | `ledger/events.jsonl`、`runs/<run-id>/`、Artifact hash、测试/验收记录 | 部分落地，可手工执行 |
| OUTER 跨任务进化 | 复盘窗口、完成/失败 Run 集合、失败/门禁事件、Artifact 结果、Approval 决定、Knowledge 使用和历史改进建议 | Harness Review、pending pattern candidates、知识缺口、Skill/门禁改进建议、后续 Task/Plan Pack、批准状态 | Run/ledger 汇总、Artifact/verifier 结果、Knowledge 引用/修订、历史改进 Task | 已实现只读聚类；人工确认和回归应用待接 |

### 记录完整性要求

- `source_refs`、`evidence_refs`、`input_refs` 和 `output_refs` 必须能定位到 Source record、Knowledge ID、Artifact ID、Run 文件或外部对象 ID；不能只写自然语言描述。
- 每个 Loop 的输出即使为空，也必须保留字段，例如没有冲突时写 `conflicts: []`，不能省略字段让下游无法判断“没有”还是“没有检查”。
- 角色交接必须追加 Handoff/步骤事件，带 `task_id`、`run_id`、角色 ID、Skill ID、输入引用、输出引用和 gate 结果；失败必须带原因和下一步。
- Harness 的模式发现只能产生候选改进，涉及权限、状态、数据契约或外部副作用时，必须转为 Plan Pack + Approval。

### INNER：单条知识收敛

```text
capture
  → normalize
  → classify
  → deduplicate
  → evidence gate
  → conflict / freshness check
  → admit or clarify
  → index
```

INNER 的确定性检查包括 schema、来源、敏感度、链接、重复 ID 和索引一致性；语义分类、矛盾判断和摘要由 Agent 处理。最多局部修复三轮，仍不确定则进入人工澄清。

### MID：单个 Task 收敛

```text
prepare
  → build context
  → plan
  → execute steps
  → verify
  → approval if required
  → finish and write back
```

失败处理只有四种：重试当前步骤、回溯上游步骤、进入人工批准、终止本次 Run。Harness Agent 给出语义决策，Framework 执行决定并记录原因。

### OUTER：跨 Task 进化

OUTER 每周读取运行摘要和已验证结果，不直接吞原始长日志。它识别四类问题：知识没有帮到任务、Agent/Skill 经常失败、门禁设计与真实风险不匹配、同一类任务存在可复用的新模式。输出包括运行复盘、知识缺口、Skill/门禁改进建议和候选 Plan Pack；涉及状态、权限和数据契约的补丁必须进入 Plan Pack 并由人工批准。

## 三类可观测性

| 类型 | 产物 | 回答的问题 |
|---|---|---|
| Component | component-manifest.yaml | 系统有哪些可编辑组件，改了如何回滚 |
| Experience | step-report、run-digest、experience-corpus | 发生了什么，哪种修法被验证过 |
| Decision | decision-log.jsonl | 为什么这样决定，预测后来是否成立 |

### Structured Harness Events

每个 Run 可以通过 `ikb run event <run-id> --type <event-type> --payload '<json>'` 追加 `harness-events.v1` 事件：`loop_started/finished`、`step_started/finished`、`handoff`、`gate_evaluated`、`verification_completed`、`evaluation_completed`、`artifact_linked`、`approval_checked` 和 `action_executed`。事件 payload 只允许稳定引用、状态、版本、计数和 hash；Prompt、模型输出、文件路径、URL、人物身份和原始 Approval payload 不属于事件契约。

`run.finished=succeeded` 仍然只是终态。本地 run-quality projection 只有在必要 Gate、Verifier、Evaluation 和 Artifact 链齐全且通过时才标记 `quality_state=pass`；否则为 `block/partial`。本地 evaluator、HTML 报告和 Ledger 不依赖外部观测服务。

### Event Ledger

Task、Run、Approval、Artifact、Source 和 Knowledge 的每次变更都先追加到本地 `events.jsonl`，再由读取方重放为当前状态投影。事件一经写入不可修改和删除。

每条事件至少包含：`event_id`、对象类型与 ID、对象内递增序号、事件类型、操作者、时间、`causation_id`、变更摘要、payload hash、前一事件 hash 和当前事件 hash。状态、日报和周报都可以从事件重建；任何无法关联事件的状态修改都视为数据损坏。多进程写入通过账本锁串行化，索引数据库只能作为可删除的派生数据。

每个 Run 的标准目录：

```text
runs/<run-id>/
  input.json
  context-pack.md
  plan.json
  events.jsonl
  checkpoint.json
  artifacts/
  verification.json
  run-digest.md
```

## 权限与副作用

| 等级 | 动作 | 默认策略 |
|---|---|---|
| L0 | 读取、搜索、分析 | 自动 |
| L1 | 生成草稿、报告、候选知识 | 自动，保留 diff |
| L2 | 本地可逆写入、创建分支、修改工作区文件 | 自动，必须可回滚 |
| L3 | push、CR 评论、ONES 更新、日程修改、大象发送 | 人工门禁 |
| L4 | 删除、权限、人事、支付、生产变更 | 禁止自动执行 |

Action Gateway 是唯一副作用入口。CLI、未来的 UI、Agent prompt 和 Skill 脚本都不能绕过它。授权判断读取 manifest、本次 Task 的风险等级和不可变 Approval 记录，不信任调用方传入的“已批准”字段。

## Context Pack 契约

Context Builder 使用一个统一 search 原语，允许关键词、属性、链接和语义召回作为内部策略，但上层只依赖统一结果。

context pack 至少包含：任务目标与验收、当前状态、强制约束、相关决策、历史 pitfall、外部对象摘要、来源列表和未知项；对每条 Knowledge 还要带出 `use_when/use_inputs/use_outputs/use_steps/use_checks/use_stop_conditions` 使用契约。默认同时检索 `verified` 和 `draft`：verified 可作为可信规则，draft 必须标为 advisory 并先核对来源/未决项；要求严格时可使用 `--verified-only`。达到任务所需信息后停止，不追求塞满上下文。

Agent 在结果中声明 knowledgeReferences：用了哪条知识、用于哪个判断、状态是 trusted 还是 advisory、是否被本次结果验证。Context Pack 绑定 Run 时账本写入 `knowledge.referenced`；真实 Task 验收后可用 `knowledge.feedback_recorded` 记录 helpful/partial/incorrect/unused 和稳定原因码。只有后续真实 Task 验证才推动知识成熟度，路由阶段扫到文档不算引用。

## 六类工作流契约

| 工作流 | 关键输入 | 主要产物 | 完成门禁 |
|---|---|---|---|
| coding | Task、代码、设计、规范、历史决策 | diff、测试报告、变更说明 | 测试通过；push 前人工确认 |
| review | 方案/代码、验收条件、风险规则 | 分级问题、结论、缺失验证 | 结论有证据；外部写入前确认 |
| cr | PR/CR、diff、调用链、pitfall | 行级意见、阻塞项、审查报告 | 行号有效；提交评论前确认 |
| document | 目标、事实、模板、读者 | 文档草稿、来源、待确认项 | 事实可追溯；发布前确认 |
| communication | 对象、目的、上下文、风险 | 大象消息草稿、备选措辞 | 不自动发送 |
| upward-management | 目标、结果、风险、资源诉求 | 汇报材料、决策请求、问答准备 | 数据有来源；不自动发送 |

## Plan Pack 使用判定

每个 Task 在进入实施前运行一次 impact classifier：

```text
命中以下任一项 → 建议 Plan Pack
  1. 修改持久化 schema 或稳定数据契约
  2. 修改 Knowledge / Task / Run 状态语义
  3. 新增或扩大外部副作用权限
  4. 修改 Harness 回溯、恢复或并发语义
  5. 跨两个以上独立运行时，且失败后无法单点回滚

否则 → Task + acceptance + 必要的轻量设计说明
```

用户可以提高记录强度；critical 风险变更不能降低为普通 Task，也不能绕过人工批准。

Plan Pack 不是独立流程引擎，只是当前 Task 的方案附件：`brief.md` 说明目标与非目标，`design.md` 说明结构与取舍，`contracts.md` 冻结稳定边界，`checks.md` 定义验证与回滚，`tasks.md` 拆分实施步骤。它的状态仍由 Task 和 Run 管理。

冷启动例外：当前方案文档承担 v0.1 的基线契约，首次实现不再为同一内容重复生成 Plan Pack。v0.1 之后对稳定契约的修改才执行 impact classifier。
