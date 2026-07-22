# ikb 本地 Source Slice 验收

本切片只证明一件事：给 ikb 一份本地对话、重要文档或评论材料，Agent 能拿到带来源的上下文，并把分析结果沉淀为 draft 知识。

## 本轮必须落地

| 能力 | 验收结果 |
|---|---|
| JSONL 对话导入 | 每行归一化为带 `source_id`、`conversation_id`、`message_id` 的记录 |
| Markdown 文档/评论导入 | 形成一条可定位的 document/review_comment 记录 |
| 本机 Agent 历史适配 | 自动发现并导入 Claude Code、Codex、Desk 的 JSONL 会话；支持指定目录的 Elephant 批准导出 |
| 大象有界桥接 | 通过已登录页面的 `dx history` 拉取指定 uid/gid/pid/name/mis 的有限消息，保存原始响应并归一化文本节点 |
| 大象人物视图 | 在已导入的 Elephant Source 上按 name/uid/mis 筛选发言，保留前后文和原始 record 引用，跨快照去重 |
| 关键人物目录 | `ikb people list|add|update|remove` 维护本地 MIS/UID/显示名目录，默认工作域且不进入 Git |
| 跨来源人物视图 | `ikb people view|rebuild` 将 Citadel 文档/评论、大象和 Agent Source 按明确身份聚合到 Obsidian 可重建人物页 |
| 学城文档与评论 | 通过 `oa-skills citadel --raw` 导入当前正文/元信息，以及划词评论、全文评论和回复 |
| 学城搜索与输入候选池 | `source search-citadel` 保存搜索快照并可入池；`candidate discover` 从 Source 发现学城引用；维护流程可自动将候选 `resolve-all` 为正文/评论 Source，手工 `resolve` 仍要求 `queued` |
| 原始证据 | 原文件复制到项目内 `ikb-data/sources/<source-id>/raw/`，raw 与 normalized records 分别保存内容 hash；追加型快照可通过 `source compact-raw` 共享 CoW 前缀 |
| Context 导出 | `ikb source context` 输出带记录 ID、角色、时间和 refs 的 Markdown |
| Agent 接口 | `ikb-source-intake`、`ikb-conversation-analysis`、`ikb-knowledge-curator` 可被对应角色读取和调用；角色 manifest、中文名、门禁和 Run 启动校验已落地 |
| 知识回写 | 分析结论可通过 `ikb capture --collection <name>` 进入对应 collection 的 draft，保留 `source_kind` 和 `source_refs` |
| 可追溯 | `source.ingested` 写入事件账本，`ikb doctor` 检查 raw hash、normalized JSONL 和记录数量 |

## 角色层当前状态

本切片已经登记六个逻辑角色：任务总管（`ikb-harness`）、资料采集员（`ikb-intake`）、证据分析员（`ikb-analyst`）、知识策展员（`ikb-curator`）、工作执行员（`ikb-operator`）和验收审计员（`ikb-verifier`）。中文名只用于人查看，稳定 ID 用于 Run、事件账本和后续恢复。

当前真实边界：

- 资料采集员的 Source 导入、完整性检查和人物/来源视图已真实跑通；
- 学城搜索、引用发现和候选状态机已可运行；维护流程按滚动 30 分钟最多 10 篇、文档间隔 2 秒读取候选池，官方 `oa-skills` 在当前机器不可用或文档无权限时，resolve 会明确失败、标记 `blocked` 且不会伪造 Source；
- 知识策展员的 draft、source_refs、Obsidian 关系、verify 和 rebuild 已可用，但主要是手工触发；
- 任务总管的 Task/Run/Approval/Artifact 控制面、角色查询和 Run 启动校验已可用；
- INNER/MID/OUTER 的输入、输出和证据来源契约已可查询，但仅是运行前契约，不代表三层自动 Loop 已经执行；
- 证据分析员、工作执行员和验收审计员已有 Skill/manifest 或底层校验，但尚未形成自动节点交接；
- 任务总管的单次复盘、跨 Task 模式发现和优化建议属于后续 Harness OUTER LOOP，不属于本 Source Slice 的已完成能力。

因此，本切片证明的是“来源可接入、证据可引用、知识可形成 draft”，不是完整的多角色自动工作流。

## 本轮不落地

- 大象无目标全量扫描、实时订阅和自动发现关键人物；当前只做有界 `dx history` 或批准的本地导出；
- 增量游标、跨来源全量去重和冲突合并；
- 人物画像自动晋升 verified；
- FTS5、Embedding、关系图谱索引；
- 自动发送大象、提交 CR、push 或其他外部写入；
- 完整 Agent runtime 和定时 daemon。

## 可复现命令

```bash
./bin/ikb init --home /tmp/ikb-demo
./bin/ikb source ingest examples/source/agent-session.jsonl \
  --kind ai_conversation --scope work --home /tmp/ikb-demo
./bin/ikb source discover --adapter all --limit 20
./bin/ikb source ingest-history --adapter claude --scope work --limit 20
./bin/ikb source ingest-history --adapter elephant --root /path/to/approved-elephant-export --scope work --limit 20
./bin/ikb source compact-raw --scope work --dry-run
./bin/ikb source ingest-citadel <content-id> --scope work
./bin/ikb source search-citadel --keyword "验价" --limit 20 --enqueue --scope work
./bin/ikb candidate list --status discovered --scope work
./bin/ikb candidate update <candidate-id> --status queued
./bin/ikb candidate resolve <candidate-id>
./bin/ikb candidate resolve-all --scope work --limit 10 --delay-ms 2000
IKB_ELEPHANT_CDP_URL=http://127.0.0.1:9222 ./bin/ikb source ingest-elephant \
  --gid <group-id> --type group --limit 10 --scope work
./bin/ikb source person --name <person-name> --context-window 2 --scope work --limit 100
./bin/ikb people view <person-id> --scope work --limit 100
./bin/ikb people rebuild --scope work --limit 100
./bin/ikb source list --home /tmp/ikb-demo
./bin/ikb source context <source-id> --limit 100 --home /tmp/ikb-demo
./bin/ikb capture "候选结论" --title "候选知识" \
  --source-kind ai_conversation --source <source-id> \
  --collection concepts --scope work --home /tmp/ikb-demo
./bin/ikb knowledge rebuild --scope work --home /tmp/ikb-demo
./bin/ikb doctor --home /tmp/ikb-demo
```

正常运行不传 `--home` 时，数据落在当前项目的 `ikb-data/`。该目录已加入 Git 忽略，尤其用于隔离公司相关知识、聊天原文和运行账本；演示命令使用 `/tmp/ikb-demo` 是为了不污染项目本地库。

Agent 历史默认只导入最近 20 个会话；原始路径、内容 hash 和归一化参数都未变化时会跳过。工具调用结果默认不进入标准化记录，确实需要时显式加 `--include-tools`；同一文件切换该参数会生成新的可追溯 Source。历史目录默认读取本机 Agent 目录；需要隔离输入时用 `--root` 指定目录，数据落盘位置仍由 `--home` 控制。

自动测试全部使用临时 HOME 和合成正文，覆盖 direct Markdown document、review comment、Claude、Codex、Desk、Elephant、学城文档和学城评论八类输入；同时检查 raw、normalized records、Context、事件账本和 `doctor`。真实验证另外使用了一个有界大象工作群窗口和一篇学城文档；数据只写入本机 `ikb-data/`，不会上传到 GitHub。

## 下一条切片

优先补增量游标、学城历史版本差异和大象会话选择/游标。跨来源人物视图已支持有限范围内的身份匹配与快照去重；外部发送、发表评论、文档发布仍需单独的 Approval 门禁。
