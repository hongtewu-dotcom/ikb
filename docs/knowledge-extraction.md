# 知识抽取与人物蒸馏规范

这份文档规定 ikb 如何从聊天、Agent 会话、学城文档/评论和重要写作中形成可复用知识。它解决的是“什么值得长期保留、什么时候合并、如何避免把模型猜测当事实”，不是某一个向量库或 LLM 的使用说明。

## 1. 外部经验与取舍

公开项目和研究有几条相互印证的经验：

- [Mem0 的记忆 API](https://docs.mem0.ai/api-reference/memory/add-memories) 和[图记忆说明](https://docs.mem0.ai/platform/features/graph-memory)体现了“追加新证据、去重/实体链接、保留时间关系”的方向；旧事实不应被静默覆盖。
- [Graphiti 的 Episode 写入模型](https://help.getzep.com/graphiti/core-concepts/adding-episodes)把原始 Episode、实体和带时间边界的事实分开，支持增量更新；新事实可以取代当前判断，但历史和 provenance 仍保留。
- [OpenViking 的 Session 抽取流程](https://docs.openviking.ai/design/session-memory-extraction-flow)和[会话分层](https://docs.openviking.ai/en/concepts/08-session)把会话提交、压缩、长期记忆抽取和分层加载分开，强调过程可观察。
- [Microsoft GraphRAG 的索引概览](https://microsoft.github.io/graphrag/index/overview/)展示了从文本单元、实体关系到社区级摘要的分层索引；它适合多来源综合，不代表单篇文档应必然产出 Knowledge。
- [LangMem 的概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)与 [Letta 的记忆层级](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy)都把短期上下文、长期记忆和可更新的工作记忆区分开；这支持 IKB 将 Source/Episode 与可验证 Knowledge 分层。

ikb 不直接复制这些系统，也不把公开 benchmark 当作本地质量证明；只吸收四个共同原则：原始事件追加保存、语义层慢速合并、时间有效性、每条结论可回到来源。Knowledge 重跑采用“当前 Vault 替换、审计区保留”的策略：旧卡先进入 `retired`，批次完成后归档到 `ikb-data/archives/knowledge/<scope>/`，不让历史版本继续占用当前检索和 Obsidian 浏览空间。

## 2. 四层数据模型

```text
Source / delta                 原始证据，追加且不可变
  ↓ batch checkpoint
Evidence / episode             直接发言、作者、评论、决策、承诺及其上下文
  ↓ weekly consolidation
Candidate claim                原子结论，带身份、时间、证据、适用边界
  ↓ curator + human gate
Knowledge draft → verified    可复用知识；旧结论不被静默覆盖
```

人物 dossier 属于 Evidence 投影，不属于 Knowledge。它从所有可用 Source 确定性重建，删除后可以恢复；人物分析 Artifact 是某个时间窗口的合并报告；`people` collection 中的 Markdown 才是候选/正式人物知识。

## 3. 什么时候重建，什么时候抽取

### 3.1 输入与证据视图

Source 同步可以频繁执行，默认采用增量导入。每条新记录只追加 delta，并记录 logical key、hash、游标和前序 Source。它不会直接改人物页，也不会生成 Knowledge。

人物 dossier 默认在以下时机重建一次：

1. 一个明确的 intake 批次完成；
2. 每日 evidence-view 计划任务；
3. 身份目录发生变更；
4. 用户需要回答某人的当前问题时，执行一次有界 `people view`。

同一批次内有 1 条还是 10,000 条消息，都不逐条重建。没有新增 delta 且身份目录未变时，重建可以直接跳过。

### 3.2 人物分析与知识合并

人物分析默认每周运行一次，或命中以下提前触发条件之一：

- 某人新增至少 3 个 direct Episode；
- 某人的证据来自至少 2 个独立新 Source；
- 身份映射发生变化，需要重新判断归属；
- 用户明确要求分析某人或某个决策。

分析必须读取上一版 Artifact，并输出 `added / unchanged / superseded / conflicted / unknown`。新一版不能通过覆盖旧 Markdown 来“更新记忆”；如果事实变化，保留旧有效时间并建立新结论/修订关系。

### 3.3 会话 Triage 与 Experience Record

“已经入库”不等于“已经深读”。每日增量同步完成后，`experience triage` 扫描已保存的 Agent/大象会话，但默认跳过完整 tool output，只在非工具消息和结构化账本中找确定性信号：失败/阻断/重试、人工纠偏、Verifier 驳回、非显然修复、Knowledge feedback 为 `partial`/`incorrect`，以及新的决策/规则/停止条件。

命中信号的会话生成一个 `Experience Record`，只落盘：Source/record/event/Run 引用、时间、信号计数和状态；不复制聊天正文、不直接生成 Knowledge。没有信号的会话仍然保留在 Source，但不进入分析队列。体验记录按“来源原始路径 + conversation id”稳定去重，文件内容变化会更新同一记录而不是重复堆积。

每周把 Experience Record 按稳定信号模式聚类。只有满足以下任一门禁，才生成 `pending_review` 的 Knowledge Candidate：

1. 同一模式有 3 个独立 Run；或
2. 同一模式有 2 个独立 Run，并且有一次真实的 `verification_completed=result=pass` 或 `evaluation_completed=result=pass`。

“独立 Run”只能来自明确的 Source→Run 交接或 Run 事件映射，不能从聊天正文猜。候选只带证据引用、模式和待办结构，不填充未经分析的 claim；随后由 Analyst/Curator 按本规范补齐 Knowledge Card，并经过人工确认或真实 Task 验证后才可写入 Vault。这样可以让经验分析持续运行，同时避免用“生成了多少条知识”冒充质量。

## 4. 人物候选的确定性门禁

只有同时满足以下条件，才能给 Curator 提出人物 Knowledge；否则只留在 Evidence 或 `unknown`：

1. **Identity**：作者/发送者/owner 与登记的 MIS、UID、显示名或别名精确匹配；群参与、被 @、正文提名不算直接归属。
2. **Direct**：结论的核心证据必须来自直接发言、署名、明确 owner 或评论者；context 只能说明协作背景。
3. **Independent episodes**：同一观察至少出现在两个独立 Episode（不同日期、会话、文档或 Source）；单条重要原话也仍只是证据。
4. **Actionable**：观察会改变后续评审、沟通、方案准备或任务安排。消息数、活跃度、礼貌用语、一次性状态不满足。
5. **Temporal**：写明观察时间和状态（current / historical / superseded / unresolved）；新事实不删除旧事实。
6. **Inference boundary**：只能写主题、决策标准、风险约束、承诺、owner、沟通形态；禁止人格、动机、忠诚度、能力、人事或私生活推断。
7. **Trace**：每个句子都能落到 Source/record/Artifact 引用；缺一条引用就不能进入候选。

这套门禁故意偏保守。`person_profile_candidates: []` 是正常结果，不是失败；宁可保留原始证据，也不要为了“每个人都有画像”而硬凑。

## 5. 普通知识的抽取规则

普通知识也采用原子化和证据优先：

- 一条 Markdown 只表达一个可复用结论；不要把整篇文章压成泛泛摘要。
- 先写 `fact / decision / preference / playbook / entity / goal` 和适用范围，再决定是否进入 Vault。
- 先检索已有 draft/verified，判断 duplicate、revision、conflict 和 stale；新结论不能因为措辞不同就绕过重复检查。
- 重要写作必须分析“背景 → 草稿 → 评论 → 修改理由 → 最终稿”，评论被拒绝也保留原因。
- 知识准入只看未来是否会改变判断或行动，不看篇幅、模型自信或每篇文档的产量配额。
- 只有真实任务使用并通过验证，或用户明确确认，才从 draft 晋升 verified。

### 5.3 业务知识不能被压成一句话

业务来源的默认产出不是“一篇文档一张摘要卡”。对于有实际业务结构的文档，Analyst 必须保留并分层抽取：

1. 事实/概念：对象、字段、枚举、状态、生命周期和术语；
2. 入口索引：业务场景/页面/端到前端接口、Http/RPC、任务、服务和仓库；
3. 链路职责：节点、调用边、节点职责、改动边界和不改边界；
4. 执行/排查：真实输入、步骤、检查、异常分支、恢复和停止条件；
5. 决策/方案：现状问题、选择、替代方案、约束、当前/规划状态和验收证据；
6. 缺口：当前无法判断的内容及下一次取证任务。

原始 Source 不被卡片替代；卡片的每条具体主张都必须能定位到 Source 的章节、表格、代码入口或验证 Artifact。短卡只有在它确实是原子事实时才允许；“系统要标准化”“收入很重要”“链路很复杂”这类句子没有对象、动作或边界，不能作为可执行 Knowledge。

工作来源中的具体示例和评审材料只保存在本机运行数据中，不随公开代码版本管理。

本轮扩展目标、与 `individualbusinesleisure` / `traffic-kb` 的能力对照，以及 Domain/Entity/Flow/Entry/Playbook/Gap/Eval 的具体字段见[知识库抽取扩展方案](知识库抽取扩展方案.md)。后续 Analyst 必须先产出该方案定义的 `business_package`，再由 Curator 拆成可检索的多张卡；不能从一行 headline 直接生成 Knowledge。

### 5.1 按类型抽取，不用一把尺子

| 类型 | 主要抽取对象 | 初始置信度判断 | 升级依据 |
| --- | --- | --- | --- |
| `fact` | 稳定事实、约束、接口/字段语义 | 代码/配置/正式文档直接支持可为 medium；单一聊天通常 low | 当前代码/配置复核，或第二独立 Source 印证 |
| `decision` | 选了什么、为什么、替代方案、决策时间 | 有正式决策记录可 medium/high；仅规划图通常 medium | 会议结论、审批、落地提交或后续任务验证 |
| `playbook` | 前置条件、步骤、分支、观测、回滚、善后 | 来源有完整流程但没有真实演练时 medium | 演练/真实任务执行，步骤可重复且结果可验 |
| `lesson` | 事件、影响、根因、缺口、修复、复发信号 | 事故数据和复盘事实可 high；修复有效性另算 | 修复上线、回归验证、复发率或告警闭环 |
| `entity/concept` | 定义、别名、边界、关系、owner、例子 | 多个正式 Source 或代码符号一致时 medium/high | 当前目录/代码/文档三者对齐；冲突时降级 |
| `project/goal` | 目标、状态、owner、时间、依赖 | 计划会或任务记录可 medium，但时效短 | 里程碑/交付物/最新状态证据 |
| `synthesis` | 多来源共同模式、设计原则、横向规律 | 单篇横评只能 low/medium | 多批次、多任务引用并得到效果反馈 |

### 5.1.1 类型分流与人物多视角

上表的类型不是标签装饰，而是 Analyst 的抽取路由。`fact/concept` 做定义和冲突比对，`entity` 做关系/生命周期/不变量，`flow/entry` 做入口和节点遍历，`service/data_fact` 优先从代码/图谱确定性生成，`decision` 做选项和理由还原，`playbook` 做步骤与分支复现，`lesson` 做事故时间线和回归，`review/writing` 做版本差异和评论处理，`agent/experience` 做失败—纠偏—验证链。每种模式独立决定证据门槛和 Knowledge 类型，不能用一张通用摘要替代。

人物模式必须同时运行多个视图，而不是只抽“偏好”：

1. 身份/职责/owner：精确身份匹配、署名和明确负责范围；
2. 领域/问题版图：反复参与的业务域、系统和问题类型；
3. 决策标准/风险门槛：反复要求保护、衡量、避免的内容；
4. 写作结构：标题层级、证据摆放、现状—方案—边界、未知项和修改习惯；
5. 评审行为：评论关注点、阻断条件、采纳/拒绝理由和验证要求；
6. 沟通契约：需要的输入、交付格式、更新节奏和升级路径；
7. 执行闭环：拆任务、定 owner、处理阻断、跟进 TODO、验证收口；
8. 可复用能力：输入→动作→输出→结果→边界，不产出能力评分；
9. 协作关系：只记录显式上下游、交接和 owner，不从群共现推断；
10. 时间变化/反例：current、historical、superseded、conflicted、unknown 分开保留。

每个视图单独保留 Episode、来源、时间范围和置信度。只有满足身份、至少两个独立 Episode、可改变下一次协作且逐句可追溯，才允许形成人物 Knowledge draft；否则保留为 Evidence View。详见[知识库抽取扩展方案](知识库抽取扩展方案.md)的人物抽取器表。

人物之外的知识，置信度关注的是“这条内容是否成立、是否仍然当前”；人物还要额外证明“这句话确实属于这个人”。所以业务 playbook 可以先以 medium draft 服务下一次分析，人物观察则不能用一次发言直接落库。

人物卡在实现层还会拆成三个门禁字段：`identity_confidence`（身份归因）、`pattern_confidence`（跨 Episode 的工作模式）和 `independent_episode_count`。当前代码要求 `people`/`quality_version >= 2` 满足身份 high、模式至少 medium、独立 Episode 至少 2 个；即使满足也仍是 draft，只有真实 Task 验证或用户确认才能 verified。

### 5.2 Knowledge Card 最小结构

每条非人物 draft 至少包含以下内容；正文可以按类型裁剪，但不能只剩一句口号：

```text
结论：一条可复用主张
证据链：原始 Source/record、评论、代码或运行 Artifact
推导：证据如何支持结论；哪些是事实，哪些是判断
适用：什么任务、对象、时间和前置条件下使用
执行/决策：步骤、分支、输入、输出或替代方案
例外：不适用、冲突、规划状态和已知失败模式
验证：如何在真实 Task、测试、演练或用户确认中验证
置信度：level + confidence_basis；与 draft/verified 生命周期分开
```

从 `quality_version: 3` 开始，Knowledge 还必须有一个机器可消费的“使用契约”，否则只能作为证据索引，不能作为 Agent 的执行依据：

```yaml
use_when: "什么任务/触发条件下加载这条卡"
use_inputs: ["任务输入、代码/文档/数据前置条件"]
use_outputs: ["要生成的清单、文件、决策或验证记录"]
use_steps: ["按顺序执行的动作"]
use_checks: ["每一步或最终必须检查的事实/指标"]
use_stop_conditions: ["何时停止、转人工或申请 Approval"]
```

Context Pack 默认同时加载 `verified` 和 `draft`：`verified` 是可信规则，`draft` 是带 `advisory` 标记的候选方法，必须先核对其来源和未决项。只有明确要求 `--verified-only` 时才排除 draft。每次 Context Pack 绑定 Run 时，账本写入 `knowledge.referenced`，这样可以知道知识是否真的被任务使用，而不是只统计笔记数量；任务验收后再通过 `ikb knowledge feedback` 记录 helpful/partial/incorrect/unused，不能把“被检索”当成“有效”。

因此，“未完成真实 Task 验证”不再等于“不能沉淀”：有可靠证据且能改变行动的内容先进入 draft 并可被安全地试用；真实结果再决定是否升级、修订或退休。只有没有可复用动作、证据不足、重复且无新增，才 skip。

首批严格重审后的 3 条学城 Knowledge 已补齐这个 Card 的“推导、执行/决策、验证和置信度”部分；其余材料保留在 Source/Candidate，原始细节继续放在 Analysis Artifact，不把生产配置或一次性数字复制进长期知识。后续新卡片必须沿用同一结构。

## 6. 可观测性与评测

每次抽取必须保留：输入 Source/delta、窗口、身份匹配结果、Episode 列表、候选/跳过原因、旧版 Artifact、运行 ID、质量检查和下一步。至少跟踪以下指标：

- direct 与 context 命中比例；
- 候选被重复/冲突/人工驳回的比例；
- Knowledge 被真实 Task 引用后的验证通过率；
- 新增知识对任务结果的增量，而不是单纯检索命中率；
- 过期/无效知识被识别和退休的时间。

没有这些反馈，抽取量增加不代表知识库变准；`doctor` 和 `knowledge lint` 只能证明结构完整，不能替代语义验证。

## 6.1 全局推理与确认项压缩

Draft 的“待确认”不等于用户现在必须回答的问题。IKB 在已有 Source、Experience、候选池和非 retired Knowledge 上先运行一层确定性推理，按以下三类处置：

- `auto_resolved`：案例数字不泛化、规划与当前分开、敏感字段最小披露、只生成本地草稿等既有边界，自动记录理由，不重复询问；
- `defer_until_task`：最新配置/SOP、真实入口、测试数据、演练和回归报告等证据缺口，等具体 Task 取证；
- `ask_user`：人物身份与稳定观察、高风险门禁/阈值/Approval、组织策略和外部副作用，只有这类不可由当前证据推出且会改变行为的事项进入用户队列。

命令为 `./bin/ikb reasoning run --scope work`，报告落在 `ikb-data/governance/<scope>/reasoning/`，不修改 Knowledge 生命周期。它只压缩确认项，不替代后续 Experience 的语义深读；未读的远端候选不能被当成已分析输入。

## 7. Draft 交付格式：明确“要确认什么”

任何交给人的 draft 都必须在正文末尾有 `待确认（请只回复编号）`，至少拆成具体编号：

1. 主张/数字/时间是否正确；
2. 事实、规划、推断、未知的边界是否正确；
3. 适用任务和不适用范围是否正确；
4. 敏感字段是否需要删减；
5. 确认后是否允许触发下一步验证或实际使用。

人物 draft 还必须分别确认身份归因、重复观察、适用范围和 Agent 使用方式。不能写“请确认内容是否正确”这种无法行动的总括问题。确认结果要么生成修订 Artifact，要么只修改 draft 的对应字段；确认本身不等于 `verified`。
