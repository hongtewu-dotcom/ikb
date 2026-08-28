# 知识抽取与人物蒸馏规范

这份文档规定 ikb 如何从聊天、Agent 会话、学城文档/评论和重要写作中形成可复用知识。它解决的是“什么值得长期保留、什么时候合并、如何避免把模型猜测当事实”，不是某一个向量库或 LLM 的使用说明。

## 1. 外部经验与取舍

公开论文和官方实现给出的不是一套可直接照抄的“人物画像 Prompt”，而是几条可以落成门禁的共同原则：

- [Generative Agents](https://arxiv.org/abs/2304.03442)先保存完整经验流，再按时间形成高层 reflection，并在具体计划中检索使用。IKB 因此不逐条消息重写人物结论；消息先成为 Episode，人物观察由周期性 consolidation 产生。
- [Graphiti](https://github.com/getzep/graphiti)把 Episode 作为不可丢的来源事实，把从中抽出的事实做成带有效时间的图；新事实使旧事实失效，但不删除历史和 provenance。IKB 因此保留人物时间线、旧状态、反例和冲突，而不是只保存“当前画像”。
- [Zep 的时态知识图谱论文](https://arxiv.org/abs/2501.13956)把非结构化对话、结构化业务数据和历史关系放进同一时态模型。IKB 因此把人物发言、署名文档、评论、任务结果分成不同 attribution role，再做跨来源合并，不能把“出现于同一群”当作归因。
- [LD-Agent](https://aclanthology.org/2025.naacl-long.272/)将事件感知、persona extraction 和 response generation 分成可独立调整的模块，同时保留短期和长期事件记忆。IKB 因此把“看见了什么”“能形成什么人物观察”“本次任务是否应该使用该观察”拆成三个步骤。
- [THEANINE](https://aclanthology.org/2025.naacl-long.435/)保留旧记忆并用时间、因果关系组织演变；其反事实评估提醒我们不能只测“记住没有”，还要测没有某条记忆时输出是否真的变差。IKB 因此记录人物知识的实际使用反馈，不用被检索次数代替有效性。
- [PERSONAMEM](https://arxiv.org/abs/2504.14225)专门测试跨多会话的静态/动态人物属性与演变，结果显示长期变化追踪本身很难。IKB 因此不给单次或同一线程内的相近发言高置信度，也不把动态状态固化成永久偏好。
- [LongMemEval](https://arxiv.org/abs/2410.10813)同时评估多会话推理、时间推理、知识更新和应当拒答的场景。IKB 的人物回归集也必须覆盖 update、conflict、abstention，而不只覆盖 recall。
- [OP-Bench](https://arxiv.org/abs/2601.13722)把无关个性化、重复和迎合列为过度个性化错误。IKB 因此在使用人物知识前做相关性复核；即使某条观察真实，也可能不该用于当前任务。
- [Mem0](https://github.com/mem0ai/mem0)当前实现采用追加事实和实体链接，而不是让每次抽取随意覆盖旧内容。IKB 同样把 Source/Episode 当追加账本，把合并、取代和冲突留给显式 consolidation。

这些实践共同支持一个五段式人物链路：

```text
raw episode → attribution + temporal evidence → periodic consolidation
            → typed observation candidate → task-time relevance / abstention
```

ikb 不把公开 benchmark 当作本地质量证明。它只把上述经验转成确定性约束：原始事件追加保存、人物慢速重建、旧状态可追溯、结论逐条回源、使用时允许“不加载”。Knowledge 重跑采用“当前 Vault 替换、审计区保留”的策略：旧卡先进入 `retired`，批次完成后归档到 `ikb-data/archives/knowledge/<scope>/`，不让历史版本继续占用当前检索和 Obsidian 浏览空间。

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

每次 `people view` / `people rebuild` 同时生成两份私有投影：`index.md` 是有展示上限的可读页；`episodes/<evidence-fingerprint>.json` 是不受展示 limit 影响的完整直接 Episode 索引。同一 fingerprint 的文件不可变复用，证据变化新增版本，避免后续重建覆盖历史 Artifact。后者只收 `speaker/author/creator/owner/modifier/record_actor` 的明确归因记录，不收 context-only；每条记录保存精确 Source/record、归因角色、内容哈希和有界摘录，全文仍回到 Source。人物反证、时间变化和语义复现必须覆盖完整 Episode 索引的整个分析窗口，不能用截断的 `index.md` 声称“未发现反例”。证据 fingerprint 不包含生成时间；证据未变时重复重建不制造新的分析触发。

旧大象网页 DOM 快照可能把回复中的引用块当成回复者正文。人物投影必须对照 immutable raw：能确定回复正文时只提取回复者本人内容，并加入 `person-attribution:quoted-reply-suffix`；只能看到他人引用、无法恢复本人回复时，该记录不计入 direct Episode。学城只读提示可以从 Episode 展示摘录中移除，但不得修改 Source 全文、Source hash 或事实引用。

### 3.2 人物分析与知识合并

人物分析默认每周运行一次，或命中以下提前触发条件之一：

- 某人新增至少 3 个语义独立的 direct Episode；
- 某人的证据来自至少 2 个独立新 Source 且跨越至少 2 个日期；
- 身份映射发生变化，需要重新判断归属；
- 用户明确要求分析某人或某个决策。

分析必须读取上一版 Artifact，并输出 `added / unchanged / superseded / conflicted / unknown`。新一版不能通过覆盖旧 Markdown 来“更新记忆”；如果事实变化，保留旧有效时间并建立新结论/修订关系。

### 3.3 会话 Triage 与 Experience Record

“已经入库”不等于“已经深读”。每日增量同步完成后，`experience triage` 扫描已保存的 Agent/大象会话，但默认跳过完整 tool output，只在事件语义消息和结构化账本中找确定性信号：实际发生的失败/阻断/重试、人工纠偏、Verifier 驳回、非显然修复、Knowledge feedback 为 `partial`/`incorrect`，以及明确形成的新决策/规则/停止条件。系统/沙箱/自动任务上下文、嵌套 tool call/result、导入结束标记、子 Agent 角色提示、自动评估 Prompt、普通任务说明和被评估知识正文只属于输入，不算本会话发生的事件；“无错误”“BUILD SUCCESS 中的告警”“如果失败则兜底”等否定、成功或条件性描述也不能冒充真实失败。

命中信号的会话生成一个 `Experience Record`，只落盘：Source/record/event/Run 引用、时间、信号计数和状态；不复制聊天正文、不直接生成 Knowledge。没有信号的会话仍然保留在 Source，但不进入分析队列。体验记录按“来源原始路径 + conversation id”稳定去重，文件内容变化会更新同一记录而不是重复堆积。如果规则升级后发现旧记录只是提示词/工具内容假阳性，原记录更新为 `triageDisposition=ignored`、清空信号并保留排除原因；Source 因范围治理退出 active plane 时，旧 Experience 同样更新为 `ignored/source_outside_active_plane`，原始证据仍可审计。聚类只读取 `selected`，不靠删文件掩盖历史。

`selected` 仍只是高召回分析队列，不等于结论成立。Analyst 必须读 evidence record 还原“发生了什么、为什么、怎样修复、如何验证”，可以输出 `Experience Record`、Gap 或 `skip`；不能把 `failure_or_block` 这样的信号名直接发布成 Knowledge。

分析入口固定为 `ikb experience context <experience-id> --run <run-id>`。它只展开该 Episode 冻结的 `sourceRecordIds`，按时间排序并标明哪些记录触发了 Triage；同一 Source 中未属于该 Episode 的消息不会混入。默认读取完整 Episode，只有人工快速查看时才使用 `--limit 1..500`。挂到 Run 后会生成内容寻址的 `experience-context` Artifact，并记录 Experience、Source 与 Run 的产出链路；重复执行复用同一个 Artifact。这样“命中信号”与“分析时实际读到的证据”不再靠人工拼接。

同一历史会话被多个本地入口镜像导入时，Context 只展示一条逻辑消息，同时在 `equivalentRecordIds` / `equivalentSourceIds` 保留所有原始引用。镜像副本不能被算成多次复现、多个独立来源或更高置信度；`sourceRecordCount` 与 `totalRecords` 分别表示原始引用数和去重后的逻辑消息数。

真实消费者 Run 产生的 `partial/incorrect` Knowledge feedback 是另一类入口。它必须携带同 Run 的结果 Artifact；没有 Source 时，Triage 只在目标 Knowledge、同 scope Task/Run 和 Artifact hash 都能校验后生成事件型 Experience。同一 Knowledge+Run 的旧错误事件由后续纠正事件取代。该类 Experience 只能 `revise/retire` 精确目标卡，不能从一次反馈新建无关知识。

每周把 Experience Record 按稳定信号模式聚类。只有满足以下任一门禁，才生成 `pending_review` 的 Knowledge Candidate：

1. 同一模式有 3 个独立 Agent Episode；或
2. 同一模式有 2 个独立 Agent Episode，并且有一次绑定当前 Analysis 和内容 hash 未变化 Artifact 的语义验证。

“独立 Run”按去重后的顶层 Agent 会话计算；IKB 事件型 Experience 则按真实 Run ID 计算。同一会话按 6 小时时间边界切出的多个 Episode 只是独立分析单元，不能增加晋级置信度。关联 Run 只能来自明确的 Source→Run 交接或 Run 事件映射，不能从聊天正文猜。普通维护 Run 通过不等于内容验证。对现有 Knowledge 的直接反例可以由一个证据充分的 `revise/retire` Analysis 形成待复核候选，因为一个反例足以否定无条件规则，但仍不能自动改写 Vault。Candidate 支持 `architecture / decision / entity / fact / goal / lesson / playbook / preference / synthesis` 九种正式类型和八个 Vault collection；修订必须保持目标卡的 type/collection。相同 pattern 的分析若知识形状不一致，继续留在队列解决建模冲突，禁止回退成通用 lesson/synthesis。

Knowledge Candidate 使用 `pending_review → accepted/rejected → applied` 生命周期。`pending_review` 是 Curator 的内部队列，不是用户待办：主张未合并、证据不可回放、适用范围/边界/使用契约/验证计划未收敛，或没有候选内容验证时，推理层必须继续延后，不能问用户“要不要入库”。新增和修订候选交给用户时都必须附完整知识稿；接受命令用 `--file` 冻结该稿的不可变快照和 SHA-256，应用只接受相同字节。新评审包的完整稿必须是 QV5 `draft`，绑定 V3 来源清单、编译结果、Case/Product、信息损耗报告与 `canonical_key`；Core 会重新计算保真并要求正文与确定性 Product View 逐字一致。历史 QV4 稿仍可审计，但不能新建评审包。同 ID 异内容拒绝覆盖，写入中断后靠相同字节幂等补齐索引、账本和 Candidate 状态。修订稿继续使用 before/after journal，并再次核对 Candidate、目标卡和替换稿的 type/collection 一致。候选、完整稿或目标 Knowledge 有任何变化，都必须重新确认或阻断恢复，不能拿一句摘要确认替代正文确认。Principle 的 validation 还必须写一份责任归属核对：`human_policy`、`deterministic_contract` 或 `mixed`，并附理由和当前代码证据。只有代码无法替人决定的 `human_policy` 可以注册人工评审包；代码已覆盖的候选直接拒绝，混合候选先拆分或收窄。

## 4. 人物候选的确定性门禁

只有同时满足以下条件，才能给 Curator 提出人物 Knowledge；否则只留在 Evidence 或 `unknown`：

1. **Identity**：作者/发送者/owner 与登记的 MIS、UID、显示名或别名精确匹配；群参与、被 @、正文提名不算直接归属。Evidence View 必须分别输出 `speaker / author / creator / owner / modifier / record_actor / context`；修改者不能被写成作者，`record_actor` 也不能自动解释为署名。
2. **Direct**：结论的核心证据必须来自直接发言、署名、明确 owner 或评论者；context 只能说明协作背景。
3. **Semantic recurrence**：稳定观察默认至少需要 3 个语义一致但上下文独立的 direct Episode，同时覆盖至少 2 个 Source 或来源类型、至少 2 个日期。转述、同一线程的追问/回复、同一内容的粘贴、引用原话和同一文档的相邻评论只能算一个 Episode。少于该门槛只生成 `person_evidence_view`。明确、长期有效的本人规则可以在用户确认或第二独立来源印证后作为候选，但不能由模型自行宣布例外。
4. **Actionable**：观察会改变后续评审、沟通、方案准备或任务安排。消息数、活跃度、礼貌用语、一次性状态不满足。
5. **Temporal**：写明观察时间和状态（current / historical / superseded / unresolved）；新事实不删除旧事实。
6. **Inference boundary**：只能写主题、决策标准、风险约束、承诺、owner、沟通形态；禁止人格、动机、忠诚度、能力、人事或私生活推断。
7. **Trace**：每个句子都能落到 Source/record/Artifact 引用；缺一条引用就不能进入候选。
8. **Counterevidence**：必须主动检索同一时间窗内的反例、更新和冲突；没有找到也要记录搜索范围，不能写成“已证明不存在反例”。
9. **Use boundary**：候选必须同时写 `usable_for` 和 `do_not_use_for`。任务加载前重新检查相关性；与当前任务无关时不加载，禁止为了“个性化”强行套用。

这套门禁故意偏保守。`person_profile_candidates: []` 是正常结果，不是失败；宁可保留原始证据，也不要为了“每个人都有画像”而硬凑。

## 5. 普通知识的抽取规则

普通知识采用“事实完整、消费视图按需拆分”，不再要求一篇来源压成一条结论：

- Source 先形成一份 Knowledge Compilation：证据片段、事实清单、必答项覆盖、直接结论、推断、未知项和类型化消费视图。它是后续卡片的事实底座，不因卡片原子化而丢失。
- 一张消费卡可以只表达一个可复用结论，但必须引用 Compilation 中的 `fact_refs`；不能用一句抽象主张替代来源里的对象、关系、状态、数字和边界。
- 先写 `architecture / decision / entity / fact / goal / lesson / playbook / preference / synthesis` 和适用范围，再决定是否进入 Vault。
- 先检索已有 draft/verified，判断 duplicate、revision、conflict 和 stale；新结论不能因为措辞不同就绕过重复检查。
- 重要写作必须分析“背景 → 草稿 → 评论 → 修改理由 → 最终稿”，评论被拒绝也保留原因。
- 知识准入只看未来是否会改变判断或行动，不看篇幅、模型自信或每篇文档的产量配额。
- 只有真实任务使用并通过验证，或用户明确确认，才从 draft 晋升 verified。

### 5.1 业务知识不能被压成一句话

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

### 5.2 按类型抽取，不用一把尺子

| 类型 | 主要抽取对象 | 初始置信度判断 | 升级依据 |
| --- | --- | --- | --- |
| `fact` | 稳定事实、约束、接口/字段语义 | 代码/配置/正式文档直接支持可为 medium；单一聊天通常 low | 当前代码/配置复核，或第二独立 Source 印证 |
| `decision` | 选了什么、为什么、替代方案、决策时间 | 有正式决策记录可 medium/high；仅规划图通常 medium | 会议结论、审批、落地提交或后续任务验证 |
| `playbook` | 前置条件、步骤、分支、观测、回滚、善后 | 来源有完整流程但没有真实演练时 medium | 演练/真实任务执行，步骤可重复且结果可验 |
| `lesson` | 事件、影响、根因、缺口、修复、复发信号 | 事故数据和复盘事实可 high；修复有效性另算 | 修复上线、回归验证、复发率或告警闭环 |
| `entity/concept` | 定义、别名、边界、关系、owner、例子 | 多个正式 Source 或代码符号一致时 medium/high | 当前目录/代码/文档三者对齐；冲突时降级 |
| `project/goal` | 目标、状态、owner、时间、依赖 | 计划会或任务记录可 medium，但时效短 | 里程碑/交付物/最新状态证据 |
| `synthesis` | 多来源共同模式、设计原则、横向规律 | 单篇横评只能 low/medium | 多批次、多任务引用并得到效果反馈 |

### 5.2.1 类型分流与人物多视角

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

每个视图单独保留 Episode、来源、时间范围、反例检索和置信度。只有满足身份、至少 3 个语义独立 Episode、跨至少 2 个来源/来源类型和 2 个日期、可改变下一次协作且逐句可追溯，才允许形成人物 Knowledge draft；否则只保留 Evidence View。详见[知识库抽取扩展方案](知识库抽取扩展方案.md)的人物抽取器表。

人物之外的知识，置信度关注的是“这条内容是否成立、是否仍然当前”；人物还要额外证明“这句话确实属于这个人”。所以业务 playbook 可以先以 medium draft 服务下一次分析，人物观察则不能用一次发言直接落库。

个人知识还有一层独立于人物规则的类型化准入。正式个人 Knowledge 使用 `quality_version >= 4`：旧版本 draft 仍可读，但不能直接 verified 或公开发布。`preference` 需要用户确认，或两次跨日期的独立 Episode 加真实任务验证；`goal` 需要本人确认或任务验证；`fact/entity` verified 需要高置信度和来源确认；`decision` 必须记录替代方案/反证搜索；`playbook` 必须具备可执行步骤并经过真实任务验证；`lesson` 必须回到具体事件并验证改进；`synthesis` 必须保留至少两个事实引用。公共字段（来源、准入理由、适用范围、边界、时间状态、消费者问题）缺一不可。该规则由 `src/knowledge/personal-admission.ts` 统一执行，不能由各个 Skill 自行放宽。

人物卡在实现层会分别记录 `identity_confidence`、`pattern_confidence`、`independent_episode_count`、`independent_source_count`、`distinct_date_count`、`counterevidence_refs` 和 `do_not_use_for`。计数只是必要条件，不等于语义重复成立；独立性和结论支持关系还必须由保真 Verifier 检查。即使通过也仍是 draft，只有真实 Task 验证或用户确认才能 verified。

### 5.3 类型化知识，不再强制所有内容长成 Playbook

旧版 `quality_version: 3` 把每条知识都要求成 `use_steps`，实际会诱导模型把事实、架构图和人物证据编造成方法论。新版先保存事实，再按消费者需要生成不同结构：

| 类型 | 必须保留的结构 | 不强制出现 |
| --- | --- | --- |
| `architecture_map` | 节点、边、层级、版本、current/planned/unknown、缺图项 | 通用执行步骤 |
| `domain_pack` | 实体、关系、规则、状态、不变量、来源锚点 | 回滚步骤 |
| `entity_card` | 字段/属性、关系、生命周期、不变量 | 流程分支 |
| `flow_card` | 触发、顺序节点、调用边、异常、恢复 | 人为补出的架构原则 |
| `decision_card` | 背景、选项、选择、理由、被拒方案、状态、影响 | 操作步骤 |
| `principle_card` | 原则陈述、触发条件、范围、例外、依据、淘汰信号 | 一次性决策或未经人工确认的默认规则 |
| `playbook` | 前置、输入、步骤、检查、分支、回滚、停止条件 | 与执行无关的完整领域百科 |
| `person_evidence_view` | 身份角色、时间线、原话、任务/产物、反例、未知 | 稳定画像 |
| `person_observation` | 重复模式、独立 Episode、适用/禁用范围、反例和验证 | 人格与能力评分 |

所有类型仍需回答消费者问题、保留边界和验证计划，但只有 `playbook` 必须有有序步骤。事实型内容可以很长，方法型内容也可以很短；判断标准是是否保留了该类型的关键事实，不是字符数。

Context Pack 默认同时加载 `verified` 和 `draft`：`verified` 是可信规则，`draft` 是带 `advisory` 标记的候选方法，必须先核对其来源和未决项。只有明确要求 `--verified-only` 时才排除 draft。Context 强制继承 Task scope，结果受相对相关度和正文总预算约束；修订 hold 和 retired Knowledge 默认不召回。绑定 Run 后，每个内容版本自动写入不可变 `context-pack-<hash>.md`、登记 Artifact 和 produced lineage，并将 `contextHash`、Artifact ID 与 `knowledge.referenced` 关联。任务验收后再通过 `ikb knowledge feedback` 记录 helpful/partial/incorrect/unused，不能把“被检索”当成“有效”。

#### P0 纠错的可恢复隔离

能直接否定既有 Knowledge 的反例先走 `./bin/ikb knowledge correction-request <knowledge-id> --run <run-id> --artifact <artifact-id> --action <revise|retire> --reason "<reason>"`。命令要求 Artifact 是同一 Run 已登记、完整且字节/hash 仍可校验的文件，并要求该 Run 的 Task scope 等于目标 Knowledge scope；因此 work Artifact 不能隔离 personal 卡。相同目标、Run、Artifact、动作和原因幂等复用一个 `pending_review` correction Candidate，且不修改目标卡的正文、status 或 revision。

`pending_review` 和 `accepted` 的 revise/retire correction Candidate 都自动成为 hold：默认 `search` 与 `context` 排除目标，不能以“等待评审”为由继续投喂旧规则。`verified/user_confirmed` 也只生成完整评审包并等待人工确认，绝不静默覆盖。

替换稿完成 QV5 revision 后，使用 `./bin/ikb knowledge qv5-resolve-hold <candidate-id> --revision <revision-id>` 解锁。它只有在 Candidate 已 `accepted`、唯一目标与 scope 均匹配 revision journal、当前 reviewed Artifact hash 等于 journal 导出的 replacement Artifact hash、journal 为 `completed`，且当前目标卡仍等于 journal `afterHash` 时才标记 `applied` 并解除 hold。任何不匹配都 fail-closed，hold 保留，旧卡仍不进入默认检索。

人物知识另行 fail-closed：QV3 及更早的人物卡、不是 `person_observation` 的人物产品、或未通过当前 QV4 人物合同的记录，仍保留在 Vault 并可由 `knowledge list/show` 审计，但默认搜索与 Context Pack 不得加载。人物 dossier 和 `person_evidence_view` 是证据投影，不是给 Agent 直接套用的稳定观察；只有完成身份、语义复现、跨来源/日期、反证和禁用范围的 QV4 `person_observation` 才能进入任务时召回。

因此，“未完成真实 Task 验证”不再等于“不能沉淀”：有可靠证据且能改变行动的内容先进入 draft 并可被安全地试用；真实结果再决定是否升级、修订或退休。只有没有可复用动作、证据不足、重复且无新增，才 skip。

### 5.4 批次抽取交接门禁

批次分析不能只交付一组 Markdown。每个冻结输入必须有一个 `ikb-knowledge-compilation-result.v3` 结果，包含：

1. 按章节、段落、表格、图片、评论、附件冻结的 `source_units`，以及每个单元唯一的处置；
2. 独立冻结的 `reference_facts`，以及 preserved/paraphrased/aggregated/view_omitted/gap/conflicted/discarded/lost 处置；
3. 带原文片段和 hash 的 `evidence_units`，以及区分 direct/synthesis/inference 的 `facts`；
4. 对冻结 obligation 与 consumer question 的 coverage/question result；
5. 只引用 fact、且明确 supported/partial/contradicted/unsupported 的 `claims`；
6. 带 `canonical_key`、operation、unique value 和 question refs 的类型化 `products`；
7. `unknowns` 和重新触发条件。

交给 Curator 前执行：

```bash
./bin/ikb extraction inventory <source.md> --source-id <source-id> --file <source-inventory.json> --json
./bin/ikb extraction validate <results.json> --manifest <benchmark-manifest.json> --json
./bin/ikb extraction verify <results.json> --manifest <benchmark-manifest.json> --file <information-loss-report.json> --json
./bin/ikb extraction product-view <results.json> --case-id <case-id> --product-id <product-id> --file <knowledge-body.md> --json
```

`validate` 检查生产者交接合同；`verify` 从来源单元、参考事实、主张支持、任务问题、冲突和最小充分集重新计算信息损耗。门禁要求 P0 关键事实召回 100%、P1 重要事实有明确处置、活动主张全部 supported、核心问题全部 answered、未暴露冲突和未解释语义损耗为 0。V2 编译仍可回放，但 `publishable=false`。`product-view` 是最终正文的唯一生成器：正文过短或想补充内容时，必须修改结构化事实/产品并重跑，不能在落库前手工压缩。机器门禁通过仍不代表生产现状天然正确；高风险结论和真实任务可用性继续由人工或任务验证。

## 6. 可观测性与评测

每次抽取必须保留：输入 Source/delta、窗口、身份匹配结果、Episode 列表、候选/跳过原因、旧版 Artifact、运行 ID、质量检查和下一步。至少跟踪以下指标：

- direct 与 context 命中比例；
- 候选被重复/冲突/人工驳回的比例；
- Knowledge 被真实 Task 引用后的验证通过率；
- P0/P1 事实保留率、主张支持精度、任务问题覆盖率、冲突暴露率、语义损耗和压缩比；
- 新增知识对任务结果的增量，而不是单纯检索命中率；
- 过期/无效知识被识别和退休的时间。

没有这些反馈，抽取量增加不代表知识库变准；`doctor` 和 `knowledge lint` 只能证明结构完整，不能替代语义验证。

## 6.1 全局推理与确认项压缩

Draft 的“待确认”不等于用户现在必须回答的问题。IKB 在已有 Source、Experience、候选池和非 retired Knowledge 上先运行一层确定性推理，按以下三类处置：

- `auto_resolved`：案例数字不泛化、规划与当前分开、敏感字段最小披露、只生成本地草稿等既有边界，自动记录理由，不重复询问；
- `defer_until_task`：最新配置/SOP、真实入口、测试数据、演练和回归报告等证据缺口，等具体 Task 取证；
- `ask_user`：人物身份与稳定观察、高风险门禁/阈值/Approval、组织策略和外部副作用，只有这类不可由当前证据推出且会改变行为的事项进入用户队列。

命令为 `./bin/ikb reasoning run --scope work`，报告落在 `ikb-data/governance/<scope>/reasoning/`，不修改 Knowledge 生命周期。它只压缩确认项，不替代后续 Experience 的语义深读；未读的远端候选不能被当成已分析输入。

## 6.2 候选评审包：让人看到完整且唯一的确认对象

`pending_review` 和一次候选验证仍不等于“可以交给人看”。Curator 必须用同一个 Run 登记三类 Artifact：完整知识稿、候选验证报告、讲人话确认说明，并执行 `experience candidate-review`。评审包绑定当前 Candidate hash 和每个文件 hash；验证报告同时绑定完整稿 hash，确认说明必须用编号讲清主张、范围、边界和确认后的动作。修订候选还必须保持目标 Knowledge 的 ID、类型和目录。

reasoning 只会把当前有效的评审包放入 `ask_user`，并直接给出确认说明、完整稿和验证报告的本地可点击路径。文件被改动、Candidate 重新聚类、Artifact 跨 Run、路径越界或类型错位后，旧包自动失效，候选退回 Curator 队列；系统不会继续拿旧目录里的文件让用户确认。

## 7. Draft 交付格式：明确“要确认什么”

任何交给人的 draft 都必须在正文末尾有 `待确认（请只回复编号）`，至少拆成具体编号：

1. 主张/数字/时间是否正确；
2. 事实、规划、推断、未知的边界是否正确；
3. 适用任务和不适用范围是否正确；
4. 敏感字段是否需要删减；
5. 确认后是否允许触发下一步验证或实际使用。

人物 draft 还必须分别确认身份归因、重复观察、适用范围和 Agent 使用方式。不能写“请确认内容是否正确”这种无法行动的总括问题。确认结果要么生成修订 Artifact，要么只修改 draft 的对应字段；确认本身不等于 `verified`。
