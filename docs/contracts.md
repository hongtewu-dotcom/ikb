# ikb 执行与治理契约

## 契约先于实现

系统能否长期运行，取决于每个环节是否说清输入、输出、副作用、证据和失败出口。Agent 可以更换模型，Skill 可以升级实现，控制面可以改界面，但这些契约不能随 prompt 漂移。

## 核心对象

### Source

Source 是外部材料的可追溯入口，不等同于 Knowledge。首批 source kind 为 `elephant`、`ai_conversation`、`document`、`review_comment`、`artifact` 和 `manual`。每条 Source 必须有稳定 `source_id`、scope、sensitivity、locator 和 snapshot hash；消息、文档版本、评论和运行产物必须保留原始定位。

重要文档的草稿、版本差异、评审评论、处理理由和最终产物都属于输入。Agent 会话中的用户目标、工具调用、失败修正和最终验证同样属于输入。分析可以生成候选，但不能绕过证据引用和人工门禁直接晋升 verified。

### Knowledge

```yaml
id: kb-20260715-001
type: fact
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
```

约束：verified 必须有可访问来源或明确的人工确认记录；变更结论时追加 revision，不覆盖历史；敏感等级只能保持或升高，自动流程不得降低。关系字段使用 Obsidian `[[knowledge-id]]`，`related` 与 `contradicts` 双向维护，`derived_from` 从新知识指向依据；跨 personal/work Vault 默认拒绝，必须显式确认。关系变更追加 `knowledge.related` 事件。

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

首批 Agent：Task Orchestrator、Knowledge Curator、Coding Agent、Review Agent、CR Agent、Document Agent、Communication Agent、Upward Management Agent。

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

OUTER 每周读取运行摘要和已验证结果，不直接吞原始长日志。它识别三类问题：知识没有帮到任务、Agent/Skill 经常失败、门禁设计与真实风险不匹配。输出只能是候选补丁，涉及状态、权限和数据契约的补丁必须进入 Plan Pack 并由人工批准。

## 三类可观测性

| 类型 | 产物 | 回答的问题 |
|---|---|---|
| Component | component-manifest.yaml | 系统有哪些可编辑组件，改了如何回滚 |
| Experience | step-report、run-digest、experience-corpus | 发生了什么，哪种修法被验证过 |
| Decision | decision-log.jsonl | 为什么这样决定，预测后来是否成立 |

### Event Ledger

Task、Run、Approval、Artifact 和 Knowledge 的每次变更都先追加到本地 `events.jsonl`，再由读取方重放为当前状态投影。事件一经写入不可修改和删除。

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

context pack 至少包含：任务目标与验收、当前状态、强制约束、相关决策、历史 pitfall、外部对象摘要、来源列表和未知项。默认按 L0 路由、L1 摘要、L2 详情逐级加载；达到任务所需信息后停止，不追求塞满上下文。

Agent 在结果中声明 knowledgeReferences：用了哪条知识、用于哪个判断、是否被本次结果验证。只有 verified=true 的真实使用才推动知识成熟度，路由阶段扫到文档不算引用。

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
