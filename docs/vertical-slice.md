# ikb 本地 Source Slice 验收

本切片只证明一件事：给 ikb 一份本地对话、重要文档或评论材料，Agent 能拿到带来源的上下文，并把分析结果沉淀为 draft 知识。

## 本轮必须落地

| 能力 | 验收结果 |
|---|---|
| JSONL 对话导入 | 每行归一化为带 `source_id`、`conversation_id`、`message_id` 的记录 |
| Markdown 文档/评论导入 | 形成一条可定位的 document/review_comment 记录 |
| 原始证据 | 原文件复制到 `~/.ikb/sources/<source-id>/raw/`，保存内容 hash |
| Context 导出 | `ikb source context` 输出带记录 ID、角色、时间和 refs 的 Markdown |
| Agent 接口 | `ikb-source-intake`、`ikb-conversation-analysis`、`ikb-knowledge-curator` 可被 Agent 读取和调用 |
| 知识回写 | 分析结论可通过 `ikb capture` 进入 draft，保留 `source_kind` 和 `source_refs` |
| 可追溯 | `source.ingested` 写入事件账本，`ikb doctor` 检查 raw/normalized 文件是否存在 |

## 本轮不落地

- 直接扫描大象网页或内部 API；
- 自动发现 Claude Code、Desk、Codex 的真实历史目录；
- 增量游标、全量去重和冲突合并；
- 人物画像自动晋升 verified；
- FTS5、Embedding、关系图谱索引；
- 自动发送大象、提交 CR、push 或其他外部写入；
- 完整 Agent runtime 和定时 daemon。

## 可复现命令

```bash
./bin/ikb init --home /tmp/ikb-demo
./bin/ikb source ingest examples/source/agent-session.jsonl \
  --kind ai_conversation --scope work --home /tmp/ikb-demo
./bin/ikb source list --home /tmp/ikb-demo
./bin/ikb source context <source-id> --limit 100 --home /tmp/ikb-demo
./bin/ikb capture "候选结论" --title "候选知识" \
  --source-kind ai_conversation --source <source-id> \
  --scope work --home /tmp/ikb-demo
./bin/ikb doctor --home /tmp/ikb-demo
```

## 下一条切片

优先接本地历史 Agent 会话的真实导出格式。它只需要增加一个 source adapter，不改变 Source Message、Context 和 Skill 契约。大象接入放在这条切片通过后，单独处理权限、登录、增量游标和敏感数据边界。
