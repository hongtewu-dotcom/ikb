# ikb Source Plane

Source Plane 负责接住工作生活中的原始材料。它不等于 Knowledge Vault：原文先以证据形式保存，经过归一化、分段、分析和准入后，才形成可复用知识。

## 输入范围

| source kind | 典型内容 | 主要用途 |
|---|---|---|
| `elephant` | 大象私聊、群聊、主题讨论 | 还原决策、承诺、分歧和人物沟通偏好 |
| `ai_conversation` | Claude Code、Desk、Codex 会话 | 还原任务目标、判断过程、失败修正和有效经验 |
| `document` | 重要方案、设计、复盘、汇报、文档草稿 | 固化事实、决策、背景和约束 |
| `review_comment` | CR、代码评审、学城划词/全文评论、修改意见 | 提取风险、标准、分歧和反馈模式 |
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
  → append an incremental evidence delta
  → batch checkpoint / scheduled rebuild
  → analyze and consolidate candidates
  → attach evidence refs
  → write draft knowledge / person profile
  → human gate before verified
```

扫描必须支持增量游标和重复执行。每次扫描记录范围、游标、快照哈希、导入数量、跳过数量和失败原因；原始快照不被分析结果覆盖。

## 人物蒸馏

人物不是一条普通事实，也不是每条消息都触发一次的实时摘要。输入层先按 Source/record 增量保存；人物 dossier 是从不可变 Source 全量重建的证据投影，按 intake 批次关闭或每日计划重建，而不是在每条消息到达时叠加正文。人物分析/蒸馏是更慢的合并窗口：默认每周一次，或在出现至少 3 个新增 direct Episode、2 个独立新 Source、身份映射变更或用户明确要求时提前触发。

人物画像只能记录有证据支撑的工作模式：关注点、决策依据、风险敏感点、沟通偏好、承诺和反复出现的异议。画像候选先经过身份、独立 Episode、可行动性、时间有效性、反推边界和证据定位六道门禁；不满足条件的材料留在证据/unknown，不硬凑成 Knowledge。

画像中的每个判断都保留：

- 证据消息或文档引用；
- 观察时间范围；
- 事实、推断或待确认标记；
- 置信度和最近复核时间。

每次合并还要标记 `added`、`unchanged`、`superseded`、`conflicted` 或 `unknown`，旧结论不被静默覆盖；新结论只能进入 draft，verified 仍需要人工确认或真实任务验证。不根据少量聊天推断人格、动机或人事评价；不把人物画像自动发送给任何外部对象。

## 文档与评论输入

文档工作流至少保存四类材料：

1. 原始输入和背景材料；
2. 草稿及版本差异；
3. 评审评论和修改决定；
4. 最终文档及验证结果。

评论应归一化为 `review_comment`，包含评论者、定位信息、评论内容、处理状态和最终处理理由。被接受的评论可以形成 `decision`、`pitfall` 或 `playbook` 候选；被拒绝的评论也保留理由，供以后分析判断偏差。

## 存储与权限

文档和知识分两层落盘：ikb 的设计/契约/验收文档放在仓库 `docs/`，会进入版本管理；真实知识与原始材料按原始证据保存在项目本地 `ikb-data/`，通过 Obsidian 打开 Vault，不进入 GitHub。系统不对本地原文自动脱敏；脱敏只属于明确的对外发布流程。

目标目录（当前已落地的是每个 Source 的 `source.json`、`raw/` 和 `records.jsonl`；全局 manifest/messages/episodes 索引留给增量与分段切片）：

```text
ikb/ikb-data/sources/<source-id>/source.json
ikb/ikb-data/sources/<source-id>/raw/
ikb/ikb-data/sources/<source-id>/records.jsonl
ikb/ikb-data/sources/manifest.jsonl
ikb/ikb-data/sources/messages.jsonl
ikb/ikb-data/sources/episodes.jsonl
ikb/ikb-data/vaults/personal/{domains,projects,people,concepts,decisions,playbooks,lessons,syntheses}/
ikb/ikb-data/vaults/work/{domains,projects,people,concepts,decisions,playbooks,lessons,syntheses}/
ikb/ikb-data/governance/personal/{gaps,conflicts,reviews}/
ikb/ikb-data/governance/work/{gaps,conflicts,reviews}/
ikb/ikb-data/governance/<scope>/candidates/pool.jsonl
ikb/ikb-data/governance/<scope>/incremental/state.jsonl
ikb/ikb-data/ledger/events.jsonl
```

Source Plane 的原始数据和索引都属于项目内 `ikb-data/` 的本地私有数据，不进入公开 Git 仓库；目录使用仅当前用户可访问的权限，证据文件使用仅当前用户可读写的权限。`.gitignore` 还对常见的项目根目录数据路径做了防御性忽略。`personal` 和 `work` 默认物理隔离，关系和 Context Pack 不得跨域混用；跨域使用必须显式确认。

## 本机 Agent 历史适配器

本地适配器已经接入统一 Source 契约：

| adapter | 默认目录 | 归一化规则 |
|---|---|---|
| `claude` | `~/.claude/projects/` | 读取人类主会话，跳过 thinking、系统包装和控制记录；sidechain 仅在 `--include-tools` 下按 agent 身份保留 |
| `codex` | `~/.codex/sessions/`、`~/.codex/archived_sessions/` | 读取 `user_message` / `agent_message` 和窄化的 assistant final answer；subagent 会话仅在 `--include-tools` 下按 agent 身份保留 |
| `desk` | `~/.catpaw/projects/` | 读取 `user` / `assistant` 消息，工具记录默认关闭 |
| `elephant`（导出） | 无默认目录；必须传 `--root <approved-export-dir>` | 读取导出 JSONL/NDJSON 的消息正文、会话、发送者和参与者 |
| `elephant`（本机桥接） | 已登录大象页面的 CDP，由 `dx history` 按指定 uid/gid/pid/name/mis 拉取 | 保存 `dx --raw-payload` 原始响应；解析文本节点、@、链接、发送者、时间和 mid/uuid；必须有界，不支持无目标全量扫描；只读，不发送 |
| `citadel` | 学城 `oa-skills citadel` | 读取当前 Markdown、元信息、划词/全文评论；文档和评论拆成两个 Source，评论回复保留父子关系 |

命令分成两步：`source discover` 只列出文件路径、大小和修改时间，不复制原文；`source ingest-history` 才会把原始文件复制到 `ikb-data/sources/<source-id>/raw/`，再生成标准化 `records.jsonl`。raw 和 normalized bytes 分别保存 hash。历史适配器默认启用增量：首次导入建立 Source，后续文件追加只导入新增/变更记录；完全不变的输入跳过。每次扫描的 logical key、前序 Source、内容 hash、游标、导入/重复/变更数量追加到 `governance/<scope>/incremental/state.jsonl`，并记录 `source.incremental_scan` 账本事件。旧版没有 normalized hash 的 Source 仍可列出和读取，但会被 `doctor` 标成兼容警告，也不会作为增量去重依据。工具输出只有显式传 `--include-tools` 才进入标准化记录。只有控制记录、没有用户可见消息的文件会标为 skipped，不创建空 Source；显式传入不存在或不是目录的 `--root` 会直接失败。需要保留旧的整快照行为时，显式传 `--no-incremental`。

增量 Source 的 raw 快照保留证据边界，但不再接受物理重复无限增长。`ikb source compact-raw` 会先校验每个 raw hash，再对同内容快照使用 Copy-on-Write/硬链接，对同一逻辑会话的追加型快照共享不变前缀；Source ID、`rawPath`、normalized records 和账本均不变。报告写入 `governance/raw-dedup/`，重复运行幂等；每日维护在历史导入后自动执行。该命令依赖本机文件系统的 CoW 能力，若无法安全复用会保留原文件并报告问题，不静默删除证据。

读取 normalized records 与 raw 完整性审计分开：人物/经验/增量分析只读 `records.jsonl`，避免每次重建重复读取整份历史 raw；`source context` 和 `doctor` 仍执行 raw hash、records hash 和记录格式检查。raw 被篡改时不会被静默当作“正常 Source”，会在完整性门禁中明确报错。

定时维护显式使用 `--limit 0`，表示不按文件数截断存量历史；增量哈希和游标仍保证重复运行只导入新增/变更记录。手工临时扫描可用正数 `--limit` 做有界试跑。

```bash
ikb source discover --adapter all --limit 20
ikb source ingest-history --adapter claude --scope work --from 2026-07-10 --to 2026-07-18 --limit 20
ikb source ingest-history --adapter codex --scope work --from 2026-07-10 --to 2026-07-18 --limit 20
ikb source ingest-history --adapter desk --scope work --from 2026-07-10 --to 2026-07-18 --limit 20
ikb source discover --adapter elephant --root /path/to/approved-elephant-export --limit 20
ikb source ingest-history --adapter elephant --root /path/to/approved-elephant-export --scope work --limit 20
ikb source ingest-history --adapter codex --scope work --incremental
ikb source compact-raw --scope work --dry-run
ikb source ingest ikb-data/staging/catpaw-memory/latest.jsonl --kind manual --adapter catpaw-memory --scope work --incremental
ikb source ingest-citadel <content-id> --scope work
IKB_ELEPHANT_CDP_URL=http://127.0.0.1:9222 ikb source ingest-elephant --gid <group-id> --type group --limit 10 --scope work
ikb source person --name <person-name> --context-window 2 --scope work --limit 100
```

`ingest-citadel` 会先读取正文和元信息，再读取 `getAllComments`；正文进入 `document` Source，评论与回复进入 `review_comment` Source，均保留学城 URL、contentId、commentId、quoteId、父评论和时间。学城正文/评论默认按 contentId、commentId 做增量：正文未变化跳过，文档修订或新增评论产生新的不可变 Source。旧的 `ingest-elephant` CDP 命令只接受一个明确会话目标和有限条数（适合点查，`--limit` 上限为 500），默认通过 `dx --raw-payload` 保留原始响应；若页面/会话未登录，命令会失败而不写入 Source。大象 API/导出输入按目标和稳定 message ID 做增量，`--cursor-msg` 可作为桥接游标；若页面/会话未登录，命令会失败而不写入 Source。大象桥接的操作字段固定为 `history`，运行结果带 `readOnly: true`；代码拒绝任何发送、回复、转发、点赞、建群或改群操作。人物和群组都只能逐个、有界读取，不做无目标全量扫描。需要把已选群从网页读取到“没有更多消息”为止时，使用 `scripts/capture-elephant-browser.mjs`，不要把 `source ingest-elephant` 的 `--limit` 当作全量抓取：浏览器脚本默认不设置总条数上限，只在页面确认没有更多消息后完成；把每次生成的快照用 `source ingest ... --incremental` 导入即可只落新增/变更消息；`--max-records` 仅用于用户明确要求的部分快照，现有输出文件拒绝覆盖。例如：

```bash
node scripts/capture-elephant-browser.mjs \
  --gid <group-id> --name "示例群" \
  --output ikb-data/staging/elephant/browser-groups/<date>-gid-<group-id>-full.ndjson
```

脚本默认导航到明确群页；若当前标签页已经是同一群，可加 `--current` 复用已加载页面状态，避免重复导航。脚本只导航、等待、读取 DOM 和点击消息区的“加载更多”，不触碰输入框；针对页面虚拟化和 CatDesk 单次返回截断，按小块增量读取并按消息 ID 去重，避免 100 条或单次响应造成漏数。若页面 DOM 已膨胀到浏览器 evaluate 超时，应停止并重新打开同一群后再用 `--current` 续读；不把超时结果标记为完整。大象桥接用归一化记录做重复判断，避免每次远端响应的 trace ID 变化造成重复 Source，同时每个新快照仍保留完整原始响应。适配器只负责确定性导入和证据保存，不自动总结、不自动生成 `verified` 知识，也不做本地原文脱敏。Agent 通过 `ikb-conversation-analysis` 读取 Context，再调用 `ikb capture` 生成 `draft`。

### 输入候选池与学城发现

输入候选池是 Source 与外部入口之间的中间层，候选不是事实，也不是 Knowledge。候选记录保存在本地私有的 `governance/<scope>/candidates/pool.jsonl`，每次状态或来源变化追加一条不可变快照，并在 `ledger/events.jsonl` 追加 `candidate.*` 事件。每个候选至少保留：稳定候选 ID、`kind`、scope/sensitivity、外部定位（学城 `contentId`/URL 或搜索关键词）、发现它的 Source/record、搜索快照 hash、当前状态和解析后 Source ID。

候选状态只有以下几种：

- `discovered`：从聊天/Agent/学城搜索中发现，尚未决定读取；
- `queued`：明确允许本轮读取；
- `ingested`：已解析为正文/评论 Source，可以进入 Context 和分析；
- `rejected` / `blocked`：明确不处理或缺少授权/范围信息。

手工命令仍保留 `discovered → queued → ingested` 的显式状态；用户暂停批次时允许 `queued → discovered` 回到待处理队列。日常维护在用户授权后会自动把当前 scope 下的学城文档候选排队并读取，但默认限频：任意 30 分钟最多 10 篇，文档之间至少间隔 2 秒。每次真正发起读取前记录 `candidate.resolve_started`，失败也计入窗口；命令输出会返回已用额度、剩余额度和下一次可用时间。只有候选池里已经发现的明确 `contentId`/URL 会被读取，调用官方 `oa-skills citadel` 读取正文和评论；权限或密级不允许的文档进入 `blocked`，不会影响其他候选：

```bash
# 从已导入的 Agent/大象/文档 Source 中发现学城 URL/contentId
./bin/ikb candidate discover <source-id> --scope work
./bin/ikb candidate discover-all --scope work

# 搜索学城；结果先保存私有搜索快照，可选写入候选池，不直接读取正文
./bin/ikb source search-citadel --keyword "验价" --limit 20 --enqueue --scope work

# 查看、排队，再读取（正文和评论会拆为 Source）
./bin/ikb candidate list --status discovered --scope work
./bin/ikb candidate update <candidate-id> --status queued
./bin/ikb candidate resolve <candidate-id>

# 用户已授权时，维护流程按 30 分钟 10 篇限频读取；剩余候选留在池中
./bin/ikb candidate resolve-all --scope work --limit 10 --delay-ms 2000
# --limit 0 只表示本次不设候选数上限，仍受 30 分钟窗口约束
./bin/ikb candidate resolve-all --scope work --limit 0 --delay-ms 2000
```

`source search-citadel` 的搜索结果只作为候选证据，原始响应写入 `staging/citadel/search/`；`candidate discover` 只从明确的 URL、`contentId:` 和结构化 refs 提取，不把正文中提到的人名或普通数字误判为学城文档。候选重复按 scope、adapter、kind 和外部定位合并，新增来源/record 会追加 revision。`resolve`/`resolve-all` 成功后才产生 `document` 与 `review_comment` Source，并把它们写回候选的 `resolution.sourceIds`；读取失败只将候选标为 `blocked` 并记录原因，不会中断批次，也不会自动生成 Knowledge 或标记 `verified`。学城操作仍严格只读，不创建、编辑、评论或发送消息。

`source person` 只读取本地已导入的 Elephant Source，不做无目标远端扫描，默认 `scope=work`，个人数据必须显式传 `--scope personal`。它按 `--name`、`--uid` 或 `--mis` 筛选发送者，支持限定 Source、时间范围、条数和前后文窗口；返回结果中的每条消息都保留原始 record ID、会话 ID和 refs。重复抓取产生的不可变快照会在人物视图中按 `messageId`/`uuid`/`mid` 合并，并报告 `duplicateCount`，不覆盖原始证据。需要补充会话时，先用有界的 `source ingest-elephant`，再运行人物视图。

### CatPaw 远端记忆快照

CatPaw 远端记忆通过 `scripts/pull-catpaw-memory.py` 分页读取 `/api/memory/list`，保留每条远端对象的 `memoryId`、标题、正文、来源、agentType、标签和时间，并在标准化记录中生成 `memoryId:*`、`remoteSource:*` 等 refs。脚本只把插件凭证读自环境变量，SSO 统一走 `~/.claude/skills/flight-pipeline-automated-integration-test/scripts/token_cache.py`；快照和 manifest 只写入被 Git 忽略的 `ikb-data/staging/catpaw-memory/`。

```bash
export IKB_CATPAW_MEMORY_PLUGIN_AUTH="<本机 CatPaw 插件凭证>"
python3 scripts/pull-catpaw-memory.py --output ikb-data/staging/catpaw-memory/latest.jsonl
./bin/ikb source ingest ikb-data/staging/catpaw-memory/latest.jsonl \
  --kind manual --adapter catpaw-memory --scope work --sensitivity work-internal
```

远端记忆与 Agent 会话一样先是证据，不自动晋升为 verified Knowledge；混合个人/工作内容本轮按工作域私有快照保存，后续提炼时再拆分域。

关键人物目录通过 `ikb people list|add|update|remove` 维护，当前只保存身份元数据（MIS、可选 UID、显示名和别名），默认工作域；文件位于 `ikb-data/entities/people/key-people.json`，不进入 Git。`ikb people view <id>` 会在 `vaults/<scope>/people/<id>/index.md` 生成跨来源证据视图，`people rebuild` 批量重建启用人物。视图只按身份字段、作者/评论者/参与者和显式 refs 归集，不把正文中提到某人的内容自动归给该人；原始 Source 仍按来源分开保存，视图删除后可重建。

人物视图不会进入 Knowledge 检索：人物目录下的 `index.md` 是可重建投影；需要形成事实、决策、偏好或 playbook 时，Agent 仍要引用视图中的 Source record，再通过 `ikb capture` 写入 draft Knowledge。

非人物知识不直接做全文摘要。分析员先按类型生成 Knowledge Card：结论、证据链、推导、适用条件、执行/决策路径、例外/失败模式、验证方法、置信度依据和时间状态。`fact`、`decision`、`playbook`、`lesson`、`entity/concept`、`project/goal`、`synthesis` 使用不同的证据与升级标准；业务逻辑可以先以有边界的 medium/low draft 存在，只有真实任务验证或用户确认才升级为 verified。

## CLI 与 Skill 边界

当前可运行的本地 Source Slice：

```bash
ikb source ingest session.jsonl --kind ai_conversation --scope work
ikb source ingest design.md --kind document --scope work
ikb source ingest review.md --kind review_comment --scope work
ikb source list
ikb source context <source-id> --limit 100
ikb people view <person-id> --scope work --limit 100
ikb people rebuild --scope work --limit 100
```

CLI 只提供确定性底座和运维入口：初始化、导入、状态、备份、诊断、时间线和 Context 导出。自然语言分析交给 Skill：Skill 负责选择范围、调用 Source Context、组织上下文、生成报告和知识候选；固定的数据格式、准入门槛、权限和账本写入仍由 Core 执行。

当前 ikb 已实现本地 JSONL/Markdown Source 导入、统一增量状态、Claude Code/Codex/Desk 历史发现与增量导入、Elephant 批准导出和有界 `dx` CDP 桥接、学城文档及评论增量读取、学城搜索与输入候选池、人物发言视图、原始快照、归一化记录、Context 导出、文本/文件知识捕获和知识关系维护。大象网页抓取器本身仍是页面快照器；跨运行的浏览器 DOM 断点续读和无目标全量扫描不自动开启，外部写回仍需单独 Approval。
