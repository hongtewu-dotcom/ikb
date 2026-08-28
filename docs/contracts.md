# ikb 执行与治理契约

## 当前公开合同

IKB 的公开合同只包含四个对象和三个 Agent 意图：

| 对象 | 单一职责 |
|---|---|
| Source | 保存原始材料、来源、版本和定位 |
| Knowledge | 保存未来任务可直接复用的当前结论 |
| Inbox | 保存仍需整理、更新或人工确认的事项；文件存在即待处理 |
| Receipt | 用 `ikb-receipt.v1` 的 `kind + operations[]` 记录一次命令或维护 |

Knowledge 状态只有 `draft / verified / retired`。`helpful / partial / incorrect / unused` 是 feedback，`source_confirmed / task_validated / user_confirmed` 是 Receipt 中的验证或确认事实，`pending_review` 是 Inbox 或旧兼容对象的内部字段，三者都不扩充 Knowledge 状态机。

```text
ikb remember <path|url|text> --scope <scope>
ikb use --goal <goal> --accept <acceptance> --scope <scope>
ikb feedback <usage-id> --outcome helpful|partial|incorrect|unused [--result <path>]
```

一次公开命令或一次维护最多写一份 Receipt。`new / update / retire` 操作必须带 Source refs、before/after hash、适用边界和校验结果；Principle 的精确正文与人工确认事实必须进入同一份 Receipt。默认召回只消费 verified；incorrect 让实际使用过的 Knowledge 回到 draft 并生成 Inbox 项。

### 人工确认的最终消费者合同

只要 IKB 要求人确认 Knowledge、Principle 或 Candidate，主输出必须先生成一份 `ikb-human-confirmation-brief.v1` 单页稿。人只需要看这一份：先说明要决定什么，再展示 Agent 实际会执行的完整内容、触发条件、边界、退役信号，以及确认和驳回分别产生什么影响；结尾给出按 A/B/C 等稳定 item key 回复的格式。

hash、Artifact、Source refs、proposal path 和内部 review package 只放单页末尾的机器审计附录，不能作为人工阅读入口。一次批量最多三个主题，也只能给一份单页稿；命令和 reasoning 输出必须把 `confirmationBrief.path` 或 `primaryHumanReviewPath` 作为唯一主跳链，原始 draft、guide、validation 和 per-item review 文件只保留 internal compatibility。

用户确认只作用于明确点名的 item。执行端从已绑定的提议稿或 review package 取得内容，继续校验 scope、Artifact、hash、QV5 和当前字节；不得要求用户复制文件路径，也不得因改成人审单页而降低原有安全门禁。确认事实与精确内容 hash 进入 Receipt，未确认项保持原样。

## 内部兼容合同

以下 Task、Run、Candidate、Experience、QV5、Artifact、Ledger、Gate、Harness、发布和运维合同继续用于读取历史数据与支撑旧入口。它们不属于目标知识生命周期，也不出现在默认 HELP；新 facade 穿过真实 Agent 消费前不得删除。

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

`type` 表示知识语义，正式类型包括 `fact / decision / preference / principle / playbook / entity / goal / lesson / synthesis / architecture`；`collection` 表示 Vault 中的人类浏览位置，包括 `domains / projects / people / concepts / decisions / principles / playbooks / lessons / syntheses`。二者正交：同一个 `fact` 可以按对象进入 `people`、`projects` 或 `concepts`；`principle` 未显式指定 collection 时固定进入 `principles`。其他类型没有显式 collection 时 Core 只做保守映射，Curator 应主动选择。

`confidence` 表示证据强度，不是概率，也不等于 `status`：`low` 允许作为带边界的探索性 draft，`medium` 表示来源支持但仍需任务验证，`high` 表示多来源或强来源已相互印证。`confidence_basis` 必须说明为什么落在这个等级。`temporal_state` 描述内容是当前、规划、历史、混合、已被替代还是未知；`verification` 描述是否只完成来源确认、已被真实 Task 验证或得到用户确认。业务逻辑可以先以 medium/low draft 进入 Context 候选，人物归因默认要求 high identity confidence 与至少 medium pattern confidence；两者不能用一套阈值。

`quality_version: 4` 是新的事实编译合同：Knowledge 必须写 `product_type`、`compilation_ref`、`fact_refs` 和 `questions_answered`。只有 `playbook` 强制要求 `use_steps/use_checks/use_stop_conditions`；事实、架构、实体、流程和决策分别使用自己的类型结构，不再为了通过门禁被改写成通用操作卡。

`quality_version: 5` 是当前低损耗发布合同。除 QV4 字段外，还必须写 `canonical_key`、`compilation_schema=ikb-knowledge-compilation-result.v3`、`compilation_case_id`、`compilation_product_id`、`extraction_manifest_ref` 和 `information_loss_ref`。三个 ref 分别指向已登记并带 hash 的来源/问题清单、完整编译结果和信息损耗报告 Artifact；同一 `canonical_key` 只能有一个非 retired Knowledge。新评审包会重新读取 Source snapshot，重算保真报告，并把正文与 `extraction product-view` 的确定性输出逐字对账，所以“编译结果完整、落库只剩一句话”会被 Core 拒绝。

`principle` 是 review-first 的完整 Knowledge 语义层，不是普通事实或一次性决策的别名。Principle draft 必须满足 QV5、`product_type=principle_card`、`source_refs` 和来源准入字段；`decision_card` 不能代理 Principle。它可以通过 create/list/show/lint 进入人工评审，但默认 search、Context Pack 和 eligibility 都不消费。首次激活必须穿过 Experience Candidate 的完整确认链：Candidate 当前内容 hash 与人工接受时一致，审查稿是登记过的不可变快照，Candidate 已 accepted 并 applied 到目标 Knowledge，而且待激活稿与被接受稿逐字一致。`knowledge verify` 对 Principle 只允许把这份已接受 draft 的 `status` 改为 `verified`。

已激活 Principle 的后续人工修订可以使用 Receipt 确认链。Receipt 必须绑定点名的 Knowledge ID、用户确认时间与提议稿 hash；提议稿位于 IKB home 内且为普通文件，当前 Knowledge 的完整语义除 revision 元数据外与提议稿一致，after hash 也必须等于当前文件。Receipt 文件还要有 path 与 content hash 一致的 `receipt.written` Ledger 事件。旧 Candidate 引用存在时先校验旧链，只有 Candidate 本身有效但当前字节已发生后续修订，才允许回退 Receipt；Candidate 结构、hash 或应用状态错误时不能绕过。手工写入 `verification=user_confirmed`、直接创建 verified Principle 或事后修改正文仍不能进入默认检索。

`AGENTS.md` 只是已确认 Principle 的最小 runtime 投影，不是第二份原则主库。`knowledge principle-projection-check --manifest <json>` 只读检查 Principle 是否仍为默认可检索状态、标记块是否缺失/重复/内容漂移，以及同一 Principle 在多个文件中的投影文本是否冲突；`--write` 只在 `governance/<scope>/principles/` 生成报告和建议块，永远不自动改写 `AGENTS.md`。文本一致性可由代码判断，语义取舍和实际 diff 仍由人确认。

Source 直接提出的新 Principle 使用 `knowledge principle-request`：输入必须是同一 Run 已登记且哈希未变化的 QV5 manifest、compilation 和 fidelity Artifact，并明确选择一个 `operation=new` 的 `principle_card`。Core 会重算抽取校验与信息损耗，只生成 `pending_review` Candidate；该命令不写 Knowledge、不设置 `user_confirmed`，后续仍需完整稿、候选验证和编号确认说明组成的 Curator 审查包。

个人 Knowledge 在此基础上增加独立的类型化准入。`scope=personal` 只是数据归属，不等于可信或可公开；`quality_version < 4` 的旧个人 draft 继续可读，但只能作为 advisory，不能直接晋升 `verified` 或进入公开发布。`quality_version >= 4` 的个人 Knowledge 必须同时通过通用质量检查和下表的个人准入检查：

| 类型 | Draft 必须补齐 | Verified 额外条件 |
|---|---|---|
| `preference` | 来源、适用范围、边界、时间状态 | 用户确认，或真实任务验证且至少 2 个独立 Episode 跨 2 个日期 |
| `goal` | 明确目标来源、适用范围、时间状态 | 用户确认或真实任务验证 |
| `fact` / `entity` | 可回源事实、时间状态、编译引用 | `confidence=high`，且有来源确认、任务验证或用户确认 |
| `decision` | 选择、适用范围、边界、反证/替代方案搜索 | 用户确认或真实任务验证 |
| `playbook` | 完整输入、步骤、检查和停止条件，`product_type=playbook` | 至少一次真实任务验证或用户确认 |
| `lesson` | 至少一个具体事件 Episode、改进边界 | 真实任务验证或用户确认 |
| `synthesis` | 至少两个 `fact_refs`，保留编译来源 | 真实任务验证或用户确认 |
| `people` 中的人物观察 | 使用人物专属身份、Episode、来源、日期、反证和禁止用途门禁 | 真实任务验证或用户确认 |

这套检查由 `src/knowledge/personal-admission.ts` 提供单一接口，`knowledge capture/ingest`、状态晋升和 `knowledge lint` 共用；它只校验确定性的结构和证据计数，不让代码猜测正文是否“像偏好”或“像决定”。语义判断仍由 Analyst/Curator 产出，但缺少结构、证据或边界时不能落成正式个人 Knowledge。

`collection: people` 且 `quality_version >= 4` 的稳定观察还必须写 `identity_confidence=high`、至少 `pattern_confidence=medium`、`independent_episode_count >= 3`、`independent_source_count >= 2`、`distinct_date_count >= 2`、`counterevidence_search` 和 `do_not_use_for`。数量只是必要条件；同一线程的相邻发言、引用和粘贴仍由 Verifier 合并为一个语义 Episode。人物要变成 `verified`，还必须有 `task_validated` 或 `user_confirmed`。

知识抽取不采用“全文摘要”或“一文一卡”作为默认产物，而采用 Knowledge Compilation：证据片段及 hash、事实清单、核心问题覆盖、主张推导、类型化消费视图和未知项。Knowledge Card 是 Compilation 的消费投影，不能把未被卡片保留的关键事实藏在没有读取方的 Artifact 中。

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

候选状态是 `discovered → queued → ingested`，也可以回到 `discovered`（暂停排队）或进入 `rejected` / `blocked`。状态变更和每次新增来源/record 都追加候选快照与 `candidate.*` 账本事件。`discovered` 只表示找到了入口；手工 `candidate resolve` 仍要求先 `queued`，而用户授权的维护流程可以通过 `candidate resolve-all` 自动排队并读取当前 scope 下候选。学城读取采用滚动限频：任意 30 分钟最多 10 篇，文档间隔默认 30 秒，剩余候选留在池中；`--limit` 只限制本次最多处理数，`--limit 0` 也不能绕过 30 分钟窗口。每次实际发起读取前追加 `candidate.resolve_started` 事件，失败也计入窗口。当前首个外部候选适配器是学城：`source search-citadel` 保存搜索原始响应并可写入候选池，`candidate discover <source-id>` 从已导入 Source 的学城 URL/`contentId:` refs 中发现候选，`candidate resolve`/`candidate resolve-all` 再调用官方 `oa-skills citadel` 读取正文、元信息和评论。解析后的正文与评论分别进入 `document` / `review_comment` Source；权限或密级导致的读取失败进入 `blocked` 并记录原因，候选不会自动变成 verified Knowledge。所有学城动作均为只读，不创建、编辑、评论或发送消息。

### Key Person Directory

关键人物目录是本地私有的身份元数据，不是 Knowledge，也不自动授权跨来源扫描。每项包含 `id`、可选 `mis`/`uid`/`name`、`aliases`、`scope`、`enabled`、`createdAt` 和 `updatedAt`；默认 `scope` 为 `work`。目录文件为 `ikb-data/entities/people/key-people.json`，目录 0700、文件 0600，且不进入 Git。

`people add`、`people update` 与 `people remove` 先更新目录，再追加不可变的 `person.added` / `person.updated` / `person.removed` 事件；`people view` 与 `people rebuild` 生成可重建的人物投影，并追加 `person.view_built` 事件。`doctor` 必须能够校验这些事件链。目录只维护“查谁”的名单，人物视图只按明确身份字段和显式关联聚合 Source；形成正式知识时仍需保留原始 Source 引用。

人物处理分为四层，不能把它们混成一次写入：

1. **Source delta**：每次同步只追加不可变 Source 或增量 Source；不改人物页，不生成 Knowledge。
2. **Evidence dossier**：在 intake 批次结束、每日计划或明确查询时，对受影响 scope 做一次确定性全量投影；重复执行得到同一组证据（生成时间和账本事件除外）。可读的 `index.md` 可以按 limit 截断，但同次重建必须另写完整的 `episodes/<evidence-fingerprint>.json`，覆盖全部直接 Episode 的 Source/record 引用、归因、时间、哈希和有界摘录；同一 fingerprint 复用不可变文件，证据变化则新增版本，历史 Artifact 不得被覆盖。`context`/共现不进入该索引，也不能证明此人表达过观点。fingerprint 只由证据决定，不把重建时间算作变化。旧大象网页快照若把引用内容误作回复正文，人物投影必须从 immutable raw 恢复回复者本人内容并留下修复标签；无法确定则不得计入 direct Episode。
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

`ikb health` 只读取最近一次 `doctor --write-summary` 与 `ledger verify --write-summary` 生成的紧凑快照。它不重新扫描 Source、Knowledge 或 Ledger：账本修改时间晚于快照时必须报告 `stale`，缺少快照或完整校验失败时不能伪装成健康。完整问题明细仍只来自 `doctor` 和 `ledger verify`。

角色的 Run 启动 Agent/Task 类型/Skill 白名单已经由 CLI 校验；`run plan` 会确定性校验 DAG，并在步骤事件出现后冻结计划。Context Pack 已强制继承 Task scope、内容寻址为 Artifact 并写入 lineage，Run Eval 会在终态后检查 plan/step/artifact/gate/verifier 的完整覆盖。注意：`succeeded` 和质量结论仍是两个字段，Eval blocked 不会篡改终态，必须显式 retry 后取得 `finalPass=true`。对象级读写权限、high/critical 风险自动发起 Approval、Task done 强制绑定通过的 Verifier 等仍未全部成为前置阻断，不能在文档中宣称已自动执行。

人物检索资格由 Core 的单一函数判定，不由各 Skill Prompt 自行放宽。默认召回只接受通过当前质量门禁的 QV4 `person_observation`；历史人物卡继续可读但不进入搜索和 Context，人物 dossier/evidence view 也不能冒充 Knowledge。

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

Experience Record 只保存信号计数、Source/record/event/Run 引用、时间和状态，不复制原始长文本，也不直接生成 Knowledge。Triage 先按 adapter 与稳定 conversation ID 合并同一会话在不同历史根目录中的重复快照，再按相邻消息超过 6 小时切成独立工作 Episode；消息内容、时间、角色和引用相同的记录只保留一个规范引用。旧分段算法生成的 Experience 不删除，但标记 `segmentation_superseded`，不再参加队列或聚类。无信号的新 Episode 不落活动 Experience；曾经入队但复核后无信号的记录转为 `ignored`，不制造分析任务。自动化 Prompt、工具结果、评估题面和明确成功/否定错误不会被当作真实失败。

真实消费者产生的 `partial`/`incorrect` feedback 可能没有 Source。只有 feedback 绑定了同 scope 的目标 Knowledge、真实 Task/Run，并引用该 Run 已登记且 hash 可校验的 Artifact 时，Triage 才建立事件型 Experience。它的 Context 只投影 feedback、目标 Knowledge、Task/Run 和 Artifact 路径/hash，不复制 Artifact 正文。事件型 Experience 只能提出对被反馈 Knowledge 的 `revise/retire`；一次 feedback 暴露出的互补能力缺口不能直接创建新 Knowledge，必须回到普通 Source/Episode 证据门槛。

命中信号只进入 `experience queue`。队列按人工纠偏、Knowledge 错误反馈、Verifier 驳回、非显然修复和证据长度排序；关联 IKB 维护 Run 或普通 `verification_completed` 只表示流程关系，不作为知识内容已验证。Analyst 必须提交 `ikb-experience-analysis.v1`：标题、摘要、`candidate/skip/gap`、原因、事实/推断/未知项、精确 Source Record/Event 引用、反证搜索和未知项。`candidate` 还必须包含稳定语义模式、`new/revise/retire`、目标 Knowledge、完整适用范围、边界、使用步骤、检查项、停止条件和验证计划。引用不属于当前 Experience、缺事实、缺反证或使用契约不完整时，Core 确定性拒绝；事件型 Experience 若尝试 `new` 或指向其他 Knowledge，也会被拒绝。

Analysis 按内容 hash 写不可变 revision，Experience 只指向当前 revision；相同输入重复分析幂等。Source 内容变化、Triage 处置变化或来源退出当前分析面时，旧 Analysis 自动失效，Experience 回到 `queued`，历史 revision 仍可回放。`gap` 和 `skip` 不参加聚类。

新知识模式每周只允许两种确定性晋级条件：同一语义模式有至少 3 个独立 Agent Run，或至少 2 个独立 Run 且有一次分析专属 Artifact 验证。导入的 Agent 历史以去重后的顶层会话作为 Run 身份；同一会话按时间切出的多个 Episode 只用于分析隔离，合计仍算一个 Run。IKB 事件型 Experience 以真实 Run ID 作为身份。分析专属验证必须绑定当前 Analysis 和一个已登记、文件仍存在且 hash 未变化的 Artifact；普通维护 Run 通过不能代替内容验证。满足后生成 `ikb-knowledge-candidate.v1`，状态为 `pending_review`，并带出 claim 变体、证据、适用范围、边界、使用契约和验证方案。对现有 Knowledge 的直接反例走 `revise/retire`：一个有事实引用、目标 Knowledge 和反证搜索的 Analysis 就可以形成待复核修订候选，因为单个反例足以否定无条件规则，但仍不能自动修改 Vault。

Knowledge Candidate 不是 Knowledge，不能被 Context Pack 当作可执行规则。`pending_review` 也只表示它进入 Curator 队列，不表示已经可以让用户判断。Curator 必须先做正文级 diff，选择新增、修订、合并、退役或拒绝，保留旧版本与 lineage，并把主张、可回放证据、适用范围、边界、使用契约和验证计划整理为单一完整稿。

进入用户确认队列前还必须登记 `ikb-experience-review-package.v1`。一个评审包只绑定当前 `candidateContentHash`，并要求完整稿、至少一份验证报告和讲人话确认说明全部是同 scope、同一个 `ikb-knowledge-curator` Run 的已登记 Artifact。新完整稿必须是 QV5 draft、带 `experience-candidate:<id>`，修订稿保持目标 Knowledge 的 ID/type/collection；同时引用同 scope 的 `knowledge-extraction-manifest/result/fidelity` Artifact。Core 不信任保存的 `publishable` 字段，会用 manifest/result 重新计算报告，核对 Case/Product/canonical key/fact refs/questions，并要求正文与确定性 Product View 完全一致。验证报告必须写明 Candidate ID、当前 Candidate hash 和完整稿 hash；确认说明必须点名 Candidate、列出具体编号，并说明确认或驳回后会发生什么。历史已登记的 QV4 包仍可审计；新 QV4 包、Artifact 内容变化、路径越界、符号链接、跨 Run、类型错位或 Candidate hash 变化都会使评审包失效。`candidate-decide accept` 只接受当前评审包中的同字节完整稿。

Knowledge Candidate 的确定性状态为 `pending_review → accepted/rejected → applied`。`accepted` 只表示用户接受了当前 `candidateContentHash` 对应的候选。确认时默认使用当前评审包已经绑定、且用户从单页确认稿看到的完整知识稿，不再要求用户复制 `--file` 路径；显式 `--file` 只作为内部兼容入口，并继续做逐字 hash 校验。Core 把完整稿复制到 `experiences/reviews/<candidate-id>/<sha256>.md` 的不可变确认快照，Decision Event 只保存相对引用和 hash。`apply-candidate` 仅接受字节与确认快照一致的完整稿。

新增知识必须是同 scope、同 Candidate 类型的 QV5 `draft`，`source_refs` 同时覆盖 Candidate 的 Source 和 `experience-candidate:<id>`；Core 以原字节排他写入 Vault，同 ID 异内容、活动 `canonical_key` 冲突都拒绝。文件写入、索引重建、`knowledge.created` 和 Candidate `applied` 按固定顺序执行；任一步中断后，重跑会从已存在的同字节 Knowledge 补齐后续状态。修订知识还会重新校验目标 Knowledge、Vault 路径、before/after snapshot、revision、status、canonical key 和 journal ref；事务中断后由 `revision-recover` 幂等恢复，旧版本继续保存在 revision journal 中。

对应命令：

```bash
./bin/ikb experience triage --scope work --adapter all --limit 0
./bin/ikb experience list --scope work
./bin/ikb experience queue --scope work --limit 100
./bin/ikb experience analyze <experience-id> --file <analysis.json>
./bin/ikb experience analysis-list --scope work
./bin/ikb experience validate <experience-id> --result pass --method <方法> --note <结论> --artifact <artifact-id>
./bin/ikb experience cluster --scope work --min-samples 3
./bin/ikb experience candidate-list --scope work
./bin/ikb experience candidate-review <candidate-id> --draft <完整稿-artifact-id> --validation <验证-artifact-id> --guide <确认说明-artifact-id>
./bin/ikb experience candidate-review-show <candidate-id>
./bin/ikb experience candidate-decide <candidate-id> --decision accept --reason <讲清采用理由> --file <完整知识稿.md>
./bin/ikb experience candidate-decide <candidate-id> --decision reject --reason <讲清拒绝理由>
./bin/ikb knowledge apply-candidate <新增候选-id> --file <完整知识稿.md>
./bin/ikb knowledge apply-candidate <修订候选-id> --file <完整知识稿.md> --primary <knowledge-id>
./bin/ikb knowledge revision-list
./bin/ikb knowledge revision-recover <revision-id>
```

### 全局推理与确认项压缩

Experience、候选和 Knowledge 的数量都不是用户待办。每轮分析先执行 `reasoning`，将已有 Draft 的确认项按确定性原则分成三类：`auto_resolved`（已有边界可自动采用）、`defer_until_task`（需要最新配置/SOP/日志/真实验证，或尚未绑定具体目标的规则/Approval/外部动作）、`ask_user`（已经达到证据门槛的 Knowledge Candidate，以及人物身份与稳定观察边界）。系统保留逐条问题和证据引用，但只把真正无法自动决定的项合并成中文决策包。

```bash
./bin/ikb reasoning run --scope work --json
./bin/ikb reasoning show --scope work --json
```

报告写入 `ikb-data/governance/<scope>/reasoning/` 并追加 `reasoning.generated` 账本事件；它不改变 Knowledge 的 draft/verified/retired 状态，也不代表用户已经批准规则。HTML 观测页只展示输入覆盖、三类处置数量和压缩后的决策包；候选详情优先读取登记评审包的精确文件清单，只有尚无评审包的旧候选才使用目录扫描兼容入口。已登记评审包失效时页面拒绝降级扫描，避免把同目录旧稿混给用户。任何外部写入仍须独立 Approval，普通证据缺口不升级为即时询问。

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
| INNER 知识收敛 | `source_refs`、分析问题、scope/sensitivity、时间或 revision 边界；人物/主题和已有知识按场景提供 | Analysis Artifact、findings、evidence_refs、unknowns/conflicts、candidate_knowledge、G0～G3 结果 | `ikb-data/.system/sources/<source-id>/`、Source events、Knowledge Markdown、Analysis Artifact | 部分落地，可手工收敛 |
| MID 任务执行 | Task contract、角色/Skill manifest、Context Pack、plan/checkpoint、风险和 scope；重试时附历史 Run | handoff events、Run Artifact、Approval 记录、verification 结果、Knowledge references、G4～G6 结果 | `.system/ledger/events.jsonl`、`.system/runs/<run-id>/`、Artifact hash、测试/验收记录 | 部分落地，可手工执行 |
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

`run.finished=succeeded` 仍然只是终态。本地 run-quality projection 只有在必要 Gate、Verifier、Evaluation 和 Artifact 链齐全且通过时才标记 `quality_state=pass`；否则为 `block/partial`。本地 evaluator、HTML 报告和 Ledger 不依赖外部观测服务。Experience Candidate 使用显式知识形状：`architecture / decision / entity / fact / goal / lesson / playbook / preference / principle / synthesis` 加九个 Vault collection；修订不得改变目标卡的 type/collection，同一模式出现形状冲突时阻断聚合，不做通用类型回退。

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

context pack 至少包含：任务目标与验收、当前状态、强制约束、相关决策、历史 pitfall、外部对象摘要、来源列表和未知项；对每条 QV4+ Knowledge 带出 `product_type/compilation_ref/fact_refs/questions_answered`，QV5 额外带出 `canonical_key` 和 `information_loss_ref`，仅在类型为 playbook 时带出完整执行契约。人物观察还必须在当前问题不属于 `usable_for` 或命中 `do_not_use_for` 时抑制。默认同时检索 `verified` 和 `draft`：verified 可作为可信规则，draft 必须标为 advisory 并先核对来源/未决项；要求严格时可使用 `--verified-only`。达到任务所需信息后停止，不追求塞满上下文。结果数同时受相对分数阈值、单卡上限和正文总预算约束。

Task 标题承担主题锚点契约，必须用短语直接表达任务对象与动作；有两个必须同时消费的维度时保留两个完整短语，不能靠 goal 或 acceptance 暗示第二维度。Context Builder 用完整的标题、目标和验收召回宽候选并选择正文片段，再用标题词对 Knowledge 的标题、`use_when` 和 `questions_answered` 做主题保留。只要存在标题锚点命中，最终排序以标题查询为准，并使用固定小下限与结果上限，避免中文长标题产生的大量重叠片段让最高分卡压掉其他明确命中的维度。标题完全无命中时回退到宽候选并使用相对阈值，保证新主题不会因为锚点词典尚未覆盖而零召回。Artifact 必须记录是否启用锚点、锚点命中数、宽候选数和最终保留数，便于判断误召回和漏召回。

Context Pack 必须继承 Task scope；显式传入不同 scope 会在读取前被拒绝。绑定 Run 后，每个内容版本写入 `context-pack-<hash>.md`、自动登记 Artifact 和 `run.artifact_linked(produced)`，`context-pack.md` 只保留最新投影。Agent 在结果中声明 knowledgeReferences：用了哪条知识、用于哪个判断、状态是 trusted 还是 advisory、是否被本次结果验证。账本写入绑定 `contextHash` 和 Artifact ID 的 `knowledge.referenced`；真实 Task 验收后可用 `knowledge.feedback_recorded` 记录 helpful/partial/incorrect/unused 和稳定原因码。只有后续真实 Task 验证才推动知识成熟度，路由阶段扫到文档不算引用。

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
