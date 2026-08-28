# IKB 知识准入与 Agent 原则统一维护方案

## 1. 结论

IKB 应作为业务知识、工作经验和 Agent 原则的语义主库；`AGENTS.md` 只保留每次运行都必须自动生效的最小原则投影。两者不是二选一，也不能各自独立维护两份完整内容。

本方案把“记住一份资料”和“把资料认定为知识”拆开：

1. 用户给出的重要文档、会话主题和学城文章先进入 IKB Source，保证可查、可引用、可追溯。
2. 客观事实、系统链路和操作手册经过来源与边界检查后进入普通 Knowledge。
3. 会改变 Agent 行为的原则、限制和知识抽象进入 Principle 层，必须经过完整审查包和人工确认。
4. 已确认 Principle 中，只有不依赖语义检索也必须生效的少量规则，才人工投影到 `AGENTS.md`。

原则候选从本方案执行的第一轮就开始生成，不等待 41 条旧知识全部审完；正式进入默认检索、投影到 `AGENTS.md` 时再由人确认。

## 2. 信息放在哪里

| 内容 | 主存放位置 | 准入要求 | 默认使用方式 |
| --- | --- | --- | --- |
| 学城文章、接入文档、会话原文、CatPaw Memory 主题、评审记录 | IKB Source | 来源可定位，有版本快照和基本元数据 | 可搜索、可引用；不直接当作正确结论 |
| 客观业务事实、接口说明、系统链路、已验证故障原因、操作手册 | IKB Knowledge | 来源一致、范围明确、内容可执行或可核验 | 按任务相关性检索 |
| 跨任务原则、授权边界、验收判据、责任边界、稳定的失败规避规则 | IKB Principle | 有来源和失败背景，有适用边界、例外、验证方式，且人工确认 | 只有 `verified + user_confirmed` 才进入默认检索 |
| 每次运行必须立即生效的少量硬约束和必要入口 | `AGENTS.md` | 必须来自已确认 Principle，且遗漏会造成具体损失 | 启动时自动加载 |
| 确定性流程、格式校验、状态流转、可机械执行的门禁 | 代码、测试、linter 或 Skill 脚本 | 有真实消费者或已复现故障 | 由工具执行，不靠 Prompt 记忆 |
| 某个工具的详细用法、长 SOP、模板和示例 | 对应 Skill | 有明确触发条件和工具边界 | 使用 Skill 时渐进加载 |

判断原则只有一句：需要“知道”的放 IKB，需要“每次都立刻服从”的最小部分放 `AGENTS.md`，能够确定执行的放代码或工具。

## 3. 四层模型

```text
外部证据
  学城 / 本地文档 / 会话 / CatPaw Memory / 代码与运行结果
      │
      ▼
IKB Source
  原文快照、来源、作者、时间、版本、别名、引用关系
      │ 语义整理，不改变原始证据
      ├──────────────► 普通 Knowledge
      │                 客观事实、链路、手册、经验
      │
      └──────────────► Principle
                        原则、限制、验收与授权边界
                              │ 人工确认
                              ▼
                    默认检索 + AGENTS 最小投影
```

Source、Knowledge、Principle 和 `AGENTS.md` 投影分别解决“证据在哪里”“结论是什么”“Agent 应遵循什么”“如何保证启动即生效”，不能混成一种文档。

## 4. Source 准入：先解决 Agent 记不住资料

### 4.1 触发条件

出现以下任一情况，先做 Source intake，不等待知识抽取：

- 用户明确说“这是接入文档”“后面要用”“记住这篇”；
- 用户提供学城链接、本地文档或重要会话；
- `AGENTS.md`、Skill 或 Knowledge 引用了一个尚未进入 IKB 的主题；
- 某条 Agent 结论需要长期引用原始证据。

普通聊天不自动全量进入 IKB。只有明确重要、被引用或形成可复用结论的内容才进入 Source。

### 4.2 Intake 回执

每次 intake 至少返回：

- Source ID；
- 原始位置和标题；
- 当前版本或内容摘要指纹；
- intake 状态；
- 是否已经存在可用 Knowledge；
- 若尚未整理，明确标记“仅 Source，未准入为知识”。

这样“已经记住”表示资料已经可查和可引用，而不是 Agent 在当前会话里看过一次。

### 4.3 不同来源的处理

- 学城：优先使用 Citadel，并通过现有 `source ingest-citadel` 能力保存可追溯快照。
- 本地文档：保存受管快照、原路径和版本信息，不只记录一个可能失效的路径。
- CatPaw Memory 和会话压缩主题：先按主题批量进入 Source，再决定是否整理为 Knowledge 或 Principle。

Memory Topic 的 QV5 迁移卡只承担待审映射，不是默认可用知识。带 `memory-topic` 标签的卡片必须同时达到 `verified`、`confidence=high`，并把时间状态收敛为 `current` 或 `historical`，才能进入默认 search/context；原始迁移产生的 `draft + source_confirmed + temporal_state=mixed` 始终只可审计，不可默认召回。
- 外部转载：同时记录学城转载者、正文署名和原始出处；转载中的统计和厂商结论在独立核验前只能作为“文章陈述”。

Source 批量迁移不受“每轮最多三个语义主题”限制；这个限制只用于知识整理和原则判断。

## 5. Knowledge 准入

普通 Knowledge 需要回答五个问题：

1. 来源能否定位，是否支持当前结论？
2. 适用系统、时间、环境和业务范围是什么？
3. 它解决哪个真实消费者的问题？
4. 内容是客观事实、已验证经验，还是作者判断？
5. 代码、配置或运行时已经能直接发现的信息，是否有必要重复保存？

满足以下条件的客观内容可以直接走普通 Knowledge 审核：

- 接口字段、系统链路、业务定义、明确操作步骤；
- 有代码、配置、日志或权威业务文档支持；
- 不包含应当如何决策的规范性抽象；
- 范围和时效边界明确。

以下内容不能按普通客观知识直接放行：

- “应该”“必须”“禁止”“优先”等会改变 Agent 行为的规则；
- 从多个案例归纳出的通用方法；
- 权限、安全、资金、责任和验收边界；
- 存在来源冲突、外推或适用范围不清的结论。

这些内容应拆成事实部分和 Principle 候选。拆分是一次 `revise` 的内容策略，不新增 `split` 生命周期状态。

## 6. Principle 层

### 6.1 Principle 的最小语义

一条 Principle 至少要包含：

- 原则陈述：要求 Agent 做什么；
- 触发条件：什么时候适用；
- 适用范围和例外；
- 依据：来源、真实失败或责任边界；
- 验收方式：怎样判断执行到位；
- 淘汰信号：什么变化发生后应修订或移除；
- 与现有 Principle、Knowledge 和 `AGENTS.md` 条目的关系。

不为了字段完整而增加新的状态机。现有 QV5、verification 和 correction Candidate 契约继续承载质量、确认和修订。

### 6.2 生命周期

```text
Source / 反馈 / 失败案例
        │
        ▼
Principle candidate
        │ 形成完整审查包
        ▼
draft Principle
        │ 人工：确认 / 修订 / 拒绝
        ├────────► revise / retire candidate
        │
        ▼
verified + user_confirmed
        │
        ├────────► 按相关性进入默认检索
        └────────► 必要时人工投影到 AGENTS.md
```

`source_confirmed`、`task_validated` 或普通 verify 都不能替代 `user_confirmed`。Principle 一旦有待处理的 revise/retire Candidate，应立即形成默认检索 hold，避免旧原则继续无提示生效。

### 6.3 第一批原则什么时候生成

第一批就在本轮 Source 与引用闭环基线完成后生成，不等待旧知识全量改造。首批限定三条：

1. **证据入库与知识准入分离**：重要资料先进入 Source；进入 Source 不代表结论已经正确或默认可用。
2. **规范性抽象必须人工确认**：会改变 Agent 行为的原则、限制和知识抽象必须有完整审查包，人工确认后才能默认生效。
3. **IKB 是语义主库，AGENTS 是最小运行时投影**：完整原则只在 IKB 维护；`AGENTS.md` 只保留遗漏会造成具体损失、且每次运行都必须自动生效的短规则。

这三条在生成时仍是候选，不会因为写入文件就自动成为正式 Principle。后续每个语义维护 Run 最多处理三个主题。

第二批再考虑从学城文章抽取以下候选：

- 代码可发现的信息不维护第二事实来源；
- 一般规则改成可执行判据，确定性约束下沉到测试、linter 或代码；
- 新约束必须绑定真实失败、适用边界和可淘汰信号；
- 长期保留组织独有流程、验收标准、安全和责任边界，不复制通用模型能力。

文章只提供方向性证据，不直接定义 IKB schema；这些候选仍需结合本地失败案例和实际消费者验证。

## 7. `AGENTS.md` 投影规则

只有同时满足以下条件，Principle 才投影到 `AGENTS.md`：

1. 已是 `verified + user_confirmed`；
2. 每次运行或某类任务开始前必须生效，不能依赖检索命中；
3. 遗漏会造成明确损失，例如错误写入、越权、破坏性操作、验收失真或责任丢失；
4. 能写成简短、可执行、边界明确的指令；
5. 不能更可靠地下沉为代码、测试、linter 或 Skill 脚本。

投影采用人工审查的 diff，不自动改写 `AGENTS.md`。每条投影保留 Principle ID 或稳定引用，用检查工具发现以下漂移：

- `AGENTS.md` 条目没有对应的已确认 Principle；
- Principle 已修订或退役，但投影仍是旧内容；
- 已确认 Principle 被标记为必须启动生效，却没有投影；
- 同一原则在多个 `AGENTS.md` 中语义冲突。

`AGENTS.md` 不保存长背景、完整案例、批量业务知识和代码可直接发现的信息。详细依据回到 IKB。

## 8. 三个现有痛点的改造

### 8.1 会话压缩主题在 `AGENTS.md` 有引用，但没有进入 IKB

只读盘点已经证实，这不是单个遗漏，而是引用链没有闭合：

- CatPaw `MEMORY.md` 的 Topic Index 共核验到 43 个目标，其中 41 个已有 Source，`proj-specx.md` 和 `specx-pending-issues.md` 缺失；
- 根目录 Topic Markdown 共盘到 74 项，69 项已有 Source、5 项未接入，`catpaw-cockpit-routing.md` 的 Source hash 已落后当前文件；
- 5 个未接入样例为 `catx-multica-release-contract.md`、`codex-session-interaction.md`、`proj-specx.md`、`specx-pending-issues.md`、`traffic-biz-observer.md`；
- `daily/*.md` 62 项已有 Source，但 Topic 和 daily Source 都没有直接关联 Knowledge 的 `sourceRefs`，因此不能通过 IKB 默认 Knowledge 检索召回；
- 当前全局 `AGENTS.md` 要求 compact bootstrap 和按需读取 Topic，旧 `MEMORY.md` 仍写着每轮全文读取、自动加载全部 Topic，两者存在合同冲突；
- 实际 SessionStart 注入内容和 `memory_search` 命中率尚未做运行时验证，保持 unknown。

先做引用闭环清单，逐条记录：

- 引用位置；
- 目标主题或文件；
- Source 是否存在；
- 是否已经整理为 Knowledge 或 Principle；
- 默认检索是否可达；
- 当前缺口和修复动作。

所有原始主题先批量进入 Source，随后按每轮最多三个语义主题进行整理。新增引用闭环 lint：任何 `AGENTS.md`、Skill 或 Knowledge 指向的长期资料都必须能解析到 Source、Knowledge 或 Principle；未解析引用直接报告，但只有会导致错误执行的节点才阻断。

Source 成功不能替代默认召回成功。当前 IKB 的默认 Knowledge 搜索和 Context 候选不搜索 Source，因此需要显式建立 `Topic → Source → Knowledge/Principle` 边，并穿过默认 search/context consumer 做 canary。

### 8.2 学城文章 `2782466796`

文章《模型越来越强，harness该留下什么？》已经通过 Citadel 核查。本轮执行 `source ingest-citadel 2782466796 --scope work` 返回 `documentImported=true`、Source ID `src-a949534e-825`、exit 0。该动作只证明证据快照已导入，没有把文章结论提升为 Knowledge。后续应：

1. 保留并验证 `source ingest-citadel 2782466796 --scope work` 形成的快照；
2. 保留学城 owner、正文署名、转载来源和更新时间的区别；
3. 将“文章明确主张”和“结合 IKB 现状得出的设计推断”分开；
4. 厂商数据和百分比在未独立核验前不提升为已验证事实；
5. 只抽取对本地 Agent 有消费者的原则，不复制整篇通用方法论。

### 8.3 用户给出的接入文档会被忘记

当前已经找到三个直接样例：

- `docs/19小时完整个人知识体系Goal.md`；
- `docs/Codex接入与持续知识维护.md`；
- `docs/个人知识库完整落地方案.md`。

它们目前只在其他会话 Source 中被提及，没有自己的独立 Source，也没有对应 Knowledge，所以“会话里提过文件名”不能形成后续召回闭包。

把“收到重要文档”变成事件驱动的 Source intake，而不是等待周期性知识抽取：

1. 当轮完成快照、元数据、别名和 Source ID；
2. 当轮返回 intake 回执；
3. 尚未形成 Knowledge 时，查询可以回退到 Source，但必须标记“未整理原文”；
4. 有明确消费者后再排入语义整理队列；
5. 文档更新时新增版本，不覆盖旧证据；
6. 用一个新 Agent 任务按标题、URL 和业务别名分别查询，穿过最终检索消费者验收。

## 9. 存量 Knowledge 与 Memory Topic 的处理现状

2026-08-25 用户决定不继续把上一批 41 条 work Knowledge 当作当前基线，后续从 Source 重新编译。本轮已将这 41 条全部置为 `retired` 并移出活动 Vault，原始 Markdown 和归档账保留在 `ikb-data/archives/knowledge/work/`，不再参与默认检索。

CatPaw `MEMORY.md` 当时登记的 45 个 Topic 已全部形成一一对应的 IKB Knowledge。这个动作只证明文件、Source、hash 和 Knowledge 映射闭合，不证明语义正确。逐条语义复核后，已从活动索引和 IKB 活动 Vault 同步退役 7 个高置信度过期主题：

- `feedback-delegate-research-to-subagents.md`：强制调研委派规则与当前条件式委派规则冲突；
- `agent-spawn-contract.md`：混合历史合同与已废弃的强制委派规则；
- `specx-pending-issues.md`：2026-06 待办快照已不能表示当前状态；
- `xproduct-flighttype-alignment.md`：单次需求已完成；
- `tibet-restriction-test-status.md`：分支、泳道和测试状态属于历史任务证据；
- `delay-ticket-progress.md`：需求进度、泳道和测试订单属于历史任务证据；
- `flight-pipeline.md`：2026-07 单次 blocked 排查快照，未复核当前状态。

剩余 38 个 Memory Topic 曾以 `draft + source_confirmed` 暂存在活动区，只能证明迁移闭合，不能表述为“已验证知识”。2026-08-25 按新的准入口径完成全量分流后，这 38 张旧迁移卡已全部退役并归档，不再参与默认检索；原始 Source、迁移映射、归档账和备份继续保留。分流账见 `ikb-data/.system/runs/2026-08-25T09-21-30-333Z-task-6ea6f55a-032-run-416893b9-798/knowledge-routing.md`。

分流结果是：16 个当前事实待刷新、6 个历史证据待按事件重编译、6 个原则候选待人审、10 个混合主题待拆分。以下清单保留为重新编译时的优先级依据：

- 原则与规范抽象：`coding-principles.md`，需拆成 Principle 候选并由人确认；
- 历史与当前混写：`proj-specx.md`、`work-harness.md`、`proj-agent-evolution.md`、`ref-agent-harness.md`；
- 大型项目流水账：`proj-knowledge-base.md`、`proj-individualbusinesleisure.md`、`ikb.md`、`ikb-harness.md`、`proj-booking-refactor.md`；
- 高时效配置与能力边界：`ref-claude-code.md`、`catx-capability.md`、`exp-catpaw-config.md`、`ref-dts-mcp.md`、`ref-hive-tables.md`、`ref-traffic-wiki.md`。

这些主题包含仍可能有效的事实，当前证据只能支持“重编译、拆分或刷新”，不能支持整篇判废。其余客观排障、链路和工具经验同样仍是 draft，只有在真实任务消费并验证后才能提升状态。

后续按以下顺序改造：

1. 当前默认可检索、被 `AGENTS.md`/Skill 引用、包含原则或授权语义的卡片；
2. 高频使用但来源薄弱、范围过宽或容易过期的卡片；
3. 复合卡片，拆成客观 Knowledge 与 Principle 候选；
4. 剩余低风险客观知识。

每条只做四类判断：

- **保留**：内容客观、来源和边界足够；
- **修订**：核心仍有效，但需补来源、收窄范围或拆内容；
- **转 Principle**：主体是规范性抽象；
- **退役**：无可靠来源、已被当前事实取代或没有消费者。

每个语义 Run 最多三个主题。发现问题先建立 revise/retire Candidate 和检索 hold，再改正文；不批量覆盖旧知识，也不把结构 lint 通过当作语义验收。

## 10. 维护机制

### 10.1 事件驱动

- 新重要文档：立即 Source intake；
- 新的可复用事实：排入普通 Knowledge 整理；
- 新原则或抽象：排入 Principle 审查；
- Agent 反馈知识不准：建立 correction Candidate，必要时立即 hold；
- Principle 确认、修订或退役：检查所有 `AGENTS.md` 投影；
- 代码、配置或真实运行结果变化：优先更新事实来源，再判断知识是否失效。

### 10.2 周期维护

周期任务只消费已有队列，不自动发明原则：

- 扫描未解析引用和 Source intake 失败；
- 每轮选择最多三个语义主题；
- 检查高暴露、待反馈和待修订知识；
- 对账 Principle 与 `AGENTS.md` 投影漂移；
- 运行 doctor、ledger、health 和 knowledge lint；
- 只在完整证据和人工确认后改变 Principle 的默认可用状态。

### 10.3 责任边界

- 自动化负责：抓取、快照、去重、引用闭环、结构校验、hold、漂移报告和检索 canary；
- Agent 负责：基于证据生成候选、识别冲突、收窄范围和准备审查包；
- 人负责：原则语义、规范性抽象、冲突取舍、正式发布和 `AGENTS.md` 投影确认。

## 11. 实施顺序

### W0：收口上一轮未完成验收

- 重新运行 Principle 相关测试；
- 按固定顺序运行 doctor、ledger verify、health、knowledge lint；
- 核对上一 Task/Run 和 Artifact 状态；
- 只报告真实终态，不用已有中间产物替代最终验收。

### W1：补 Source 入口和回执

- 已将学城 `2782466796` ingest 为 Source；继续验证其可检索性和版本更新路径；
- 验证 CatPaw Memory 和本地接入文档的 intake 路径；
- 统一 Source 回执和按标题、URL、别名查询的 canary。

### W2：建立引用闭环

- 盘点全部 `AGENTS.md`、Skill 和 Knowledge 的长期资料引用；
- 先补齐 Topic Index 已知的 2 个缺失项、根目录 5 个缺失项和 1 个 stale Source，再扩展到完整 manifest；
- 解决全局 `AGENTS.md` 与旧 `MEMORY.md` 的 SessionStart/Topic 加载合同冲突；
- 为三份本地接入文档建立独立 Source；
- 建立引用 manifest 和未解析引用 lint。

### W3：生成第一批 Principle 候选

- 生成本方案第 6.3 节的三条候选；
- 对每条补齐来源、失败背景、边界、例外、验收和淘汰信号；
- 形成编号审查包，交由人确认、修订或拒绝；
- 未确认前保持 draft 且不进入默认检索。

### W4：分批改造当前 38 个 Memory Topic

- 41 条旧 Knowledge 已整体归档，不再逐卡修补，后续从 Source 重编译；
- 45 个 Memory Topic 已完成结构迁移，其中 7 个高置信度过期主题已退役；
- 剩余 38 个主题已取得唯一分流结论并整体退出活动 Knowledge：16 个 `fact_reverify`、6 个 `historical_evidence`、6 个 `principle_review`、10 个 `mixed_split`；
- 后续每轮最多处理三个重新编译主题；事实、历史证据、Principle 和混合拆分分别按各自准入门槛执行，不恢复整张迁移卡。

### W5：投影与漂移检查

- 为已确认且必须启动生效的 Principle 生成可审查 diff；
- 人工确认后更新 `AGENTS.md`；
- 增加 Principle ID 映射和语义漂移报告，不自动发布。

### W6：穿过最终消费者验收

在一个全新的 Agent 任务中验证：

1. 给定一份刚接入的文档，能按标题、URL 和业务别名找到 Source；
2. 查询客观问题时优先返回有来源的 Knowledge；
3. 查询规范性问题时只返回已人工确认的 Principle；
4. 未确认 Principle 不进入默认结果；
5. 必须启动生效的规则在不主动检索 IKB 时仍由 `AGENTS.md` 执行；
6. 回答能区分原始证据、已准入知识和设计推断。

## 12. 验收条件

方案落地完成需要同时满足：

- 学城文章、会话压缩主题和抽样接入文档都已有可引用 Source；
- 所有现有 `AGENTS.md` 长期资料引用都有明确目标和闭环状态；
- 41 条旧 Knowledge 已退出活动检索且可从归档恢复；
- 45 个 Memory Topic 都有结构映射；7 个高置信度过期主题和剩余 38 张未准入迁移卡均已归档，38 条有唯一分流结论；
- 未确认 Principle 无法通过其他 verification 状态绕过默认检索门槛；
- 已确认 Principle 与 `AGENTS.md` 投影可追溯且无已知漂移；
- 新 Agent canary 穿过真实检索与启动加载路径；
- 最终 doctor、ledger、health 和 knowledge lint 通过；
- 本地实现、知识状态和运行时效果分别报告，不相互替代。

## 13. 明确不做

- 不把所有会话自动提升为 Knowledge；
- 不让 LLM 自己确认 LLM 生成的原则；
- 不维护代码可直接发现信息的长期副本；
- 不把完整 IKB 同步进 `AGENTS.md`；
- 不自动发布或自动改写 `AGENTS.md`；
- 不为了“拆分”新增生命周期状态；
- 不用结构测试通过代替内容准确性和最终消费者验收。
