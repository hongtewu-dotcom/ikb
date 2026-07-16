# ikb Source Plane

Source Plane 负责接住工作生活中的原始材料。它不等于 Knowledge Vault：原文先以证据形式保存，经过归一化、分段、分析和准入后，才形成可复用知识。

## 输入范围

| source kind | 典型内容 | 主要用途 |
|---|---|---|
| `elephant` | 大象私聊、群聊、主题讨论 | 还原决策、承诺、分歧和人物沟通偏好 |
| `ai_conversation` | Claude Code、Desk、Codex 会话 | 还原任务目标、判断过程、失败修正和有效经验 |
| `document` | 重要方案、设计、复盘、汇报、文档草稿 | 固化事实、决策、背景和约束 |
| `review_comment` | CR、代码评审、文档评论、修改意见 | 提取风险、标准、分歧和反馈模式 |
| `artifact` | 代码 diff、测试报告、运行产物、会议纪要 | 为结论提供可验证证据 |
| `manual` | 用户直接输入的事实、偏好、决策 | 快速形成知识候选 |

重要文档的“写作过程”和“评论过程”都要保留。最终文档是产物，草稿差异、评审意见和修改原因是经验来源，不能只保存最终版本。

## 统一记录

所有适配器都归一化为以下三类记录：

```yaml
source_id: src-codex-001
kind: ai_conversation
scope: work
sensitivity: work-internal
locator: local path, URL, or export cursor
snapshot_hash: sha256
```

```yaml
source_id: src-elephant-001
conversation_id: conv-001
message_id: msg-001
actor: person-id
role: human
sent_at: 2026-07-16T09:30:00+08:00
content: 原始消息正文
participants: [person-a, person-b]
refs: [task-id, document-path, external-url]
```

```yaml
episode_id: ep-001
source_ids: [src-elephant-001]
conversation_ids: [conv-001]
title: 验价方案风险讨论
participants: [person-a, person-b]
started_at: 2026-07-15T10:00:00+08:00
ended_at: 2026-07-15T11:20:00+08:00
message_refs: [msg-001, msg-002]
```

`source_id`、`conversation_id`、`message_id` 和 `episode_id` 都是稳定标识。任何分析结论都必须能回到消息、文档版本、评论或运行产物。

## 采集闭环

```text
discover
  → snapshot raw input
  → normalize messages/documents/comments
  → deduplicate by source id and content hash
  → classify scope, sensitivity and source kind
  → segment conversations or document episodes
  → analyze and extract candidates
  → attach evidence refs
  → write draft knowledge / person profile
  → human gate before verified
```

扫描必须支持增量游标和重复执行。每次扫描记录范围、游标、快照哈希、导入数量、跳过数量和失败原因；原始快照不被分析结果覆盖。

## 人物蒸馏

人物不是一条普通事实。`person` 画像只能记录有证据支撑的工作模式：关注点、决策依据、风险敏感点、沟通偏好、承诺和反复出现的异议。

画像中的每个判断都保留：

- 证据消息或文档引用；
- 观察时间范围；
- 事实、推断或待确认标记；
- 置信度和最近复核时间。

不根据少量聊天推断人格、动机或人事评价；不把人物画像自动发送给任何外部对象。

## 文档与评论输入

文档工作流至少保存四类材料：

1. 原始输入和背景材料；
2. 草稿及版本差异；
3. 评审评论和修改决定；
4. 最终文档及验证结果。

评论应归一化为 `review_comment`，包含评论者、定位信息、评论内容、处理状态和最终处理理由。被接受的评论可以形成 `decision`、`pitfall` 或 `playbook` 候选；被拒绝的评论也保留理由，供以后分析判断偏差。

## 存储与权限

目标目录：

```text
~/.ikb/sources/<source-id>/raw/
~/.ikb/sources/manifest.jsonl
~/.ikb/sources/messages.jsonl
~/.ikb/sources/episodes.jsonl
~/.ikb/entities/people/
~/.ikb/vaults/personal/
~/.ikb/vaults/work/
~/.ikb/ledger/events.jsonl
```

Source Plane 的原始数据和索引都属于本地私有数据，不进入公开 Git 仓库。`personal` 和 `work` 默认物理隔离，关系和 Context Pack 不得跨域混用；跨域使用必须显式确认。

## CLI 与 Skill 边界

当前可运行的本地 Source Slice：

```bash
ikb source ingest session.jsonl --kind ai_conversation --scope work
ikb source ingest design.md --kind document --scope work
ikb source ingest review.md --kind review_comment --scope work
ikb source list
ikb source context <source-id> --limit 100
```

CLI 只提供确定性底座和运维入口：初始化、导入、状态、备份、诊断、时间线和 Context 导出。自然语言分析交给 Skill：Skill 负责选择范围、调用 Source Context、组织上下文、生成报告和知识候选；固定的数据格式、准入门槛、权限和账本写入仍由 Core 执行。

当前 ikb 已实现本地 JSONL/Markdown Source 导入、原始快照、归一化记录、Context 导出、文本/文件知识捕获和知识关系维护。大象、Claude Code、Desk、Codex 的自动发现/增量适配器，以及文档版本/评论的细粒度归一化，属于下一阶段 Source Plane 实现。
