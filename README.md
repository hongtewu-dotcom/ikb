# ikb

ikb 是个人工作操作系统，不是另一套笔记软件。

它把长期知识、任务执行和 Agent 能力连成一条闭环：记录事实与决策，围绕 Task 组装上下文，调用 Agent 与 Skill 完成工作，验证结果，再把有效经验写回知识库。

当前已进入 v0.1 落地：本地 CLI、JSONL 工作账本、Source Slice、六角色 manifest、G0～G6 门禁目录和 Agent-facing Skills 已可运行；角色自动交接、Harness 复盘/模式发现和完整外部 Action Gateway 按路线图逐步接入。

## 方案入口

- [产品与架构方案](docs/architecture.md)：系统解决什么问题，知识、执行和控制面如何分工。
- [当前详细架构图](docs/architecture-current.md)：按当前代码重绘的 L0/L1/L2 设计、三层 Loop、Eval Plane、真相源和数据流；可用 [draw.io 文件](docs/architecture-current.drawio) 打开。
- [模块边界与保障](docs/模块边界与保障.md)：说明每个 Plane 的真相源、允许依赖、质量门禁和渐进拆分顺序。
- [知识抽取与人物蒸馏规范](docs/knowledge-extraction.md)：增量输入、周期重建、证据门禁和知识合并规则。
- [Source Plane 设计](docs/source-plane.md)：大象、Agent 会话、文档和评论如何进入 ikb。
- [执行与治理契约](docs/contracts.md)：Agent、Skill、Harness、状态、权限和产物契约。
- [Harness 通用经验与评估规范](projects/eval-plane/docs/Harness-通用经验与评估规范.md)：应记录的事件、三层可观测性、12 个确定性 Case 和人工确认的 Outer Loop。
- [统一 Harness Eval Plane](projects/eval-plane/docs/eval-plane.md)：独立子项目中的版本化 Suite/Case/Result、四类 Adapter、L1 硬门禁和 before/after 回归比较。
- [统一评估真实 Run 接入设计](projects/eval-plane/docs/统一评估真实Run接入架构设计.md)：真实 Run、评估 Artifact、质量投影和 Outer Loop 的接入边界。
- [本地观测与评估方案](docs/本地观测与评估方案.md)：不依赖外部观测服务的 Ledger、质量投影、日报/周报和 HTML 观测页。
- [路线图与验收](docs/roadmap.md)：分阶段建设顺序、首批工作流和成功标准。
- [完整落地计划](docs/implementation-plan.md)：CLI 优先的实施拆分、数据落盘、命令设计和阶段验收。
- [本地 Source Slice 验收](docs/vertical-slice.md)：本轮已经落地的范围、命令和明确不做的部分。

## 文档与知识的最终落点

- `docs/`：ikb 自身的产品、架构、契约、实施和验收文档，随代码版本管理。
- `projects/`：IKB 总目录下的独立子项目；当前包含 Eval Plane 和 Work Harness，各自维护源码、测试与文档。
- `ikb-data/vaults/personal/`：个人知识的 Obsidian Vault。
- `ikb-data/vaults/work/`：工作/公司知识的 Obsidian Vault，只保存在本机项目目录。
- `ikb-data/sources/`：聊天、会话、学城文档/评论的原始快照及标准化记录。
- `ikb-data/staging/catpaw-memory/`：CatPaw 远端记忆的拉取快照和 manifest，导入后仍保留作为可重放输入。
- `ikb-data/governance/`：缺口、冲突、复核队列和状态视图，不混进正式知识。
- `ikb-data/governance/<scope>/candidates/pool.jsonl`：输入候选池；记录从聊天、Agent 或学城搜索发现的外部入口、状态、来源和解析结果，不直接等同于知识。
- `ikb-data/entities/people/key-people.json`：关键人物目录，只保存在本机，供人物视图和后续人物分析使用。
- `ikb-data/vaults/<scope>/people/<person-id>/index.md`：跨来源人物证据视图，可重建，不作为 Knowledge 真相源。
- `ikb-data/ledger/`：Task、Run、Source、Knowledge 变更的可校验事件账本。
- `ikb-data/runs/`：一次 Task/Agent 执行产生的 Context、草稿和验证证据。
- `ikb-data/experiences/`：Session Triage 生成的经验记录和跨 Run 的 `pending_review` Knowledge Candidate；不等于正式 Knowledge。

`ikb-data/` 是运行数据目录，已被 Git 忽略；它不是项目文档目录，也不应上传到 GitHub。`examples/` 只放不来自真实工作数据的合成样例。

## 当前判断

- Obsidian 作为知识工作台，Markdown 才是知识真相源。
- 真实个人知识与工作知识物理隔离；公开仓只放代码、模板和合成示例。
- Task 控制面负责管理工作，Run 负责记录一次执行，知识库不承载运行状态。
- 默认只读和草稿模式；大象发送、CR 评论、push、状态修改等外部动作必须过人工门禁。
- v0.1 先交付本地 CLI；现在补充一个只读本地 HTML 观测页，不承载写操作。任务、运行、审批和产物仍以 CLI/账本为真相源。
- 知识条目使用 Obsidian 兼容的 Markdown + YAML frontmatter；`related`、`derived_from`、`contradicts` 使用 `[[wikilink]]`，关系变更也进入事件账本。
- Source 不承担知识产量指标：一篇文章可以产出零条 Knowledge；没有长期价值时只留下可追溯的 skip 决定。
- 项目对外只使用 ikb 自己的术语：`task / run / approval / artifact / plan`。普通改动使用 Task + 验收条件，高风险改动增加 Plan Pack 和人工批准。
- Harness 观测直接由 IKB 本地 Ledger 生成确定性质量投影和 HTML 报表，不依赖外部观测服务或容器。Ledger、Source、Artifact 和 Knowledge 仍是唯一真相源；观测服务停止不会影响 Run、Approval 或知识准入。

## 本地启动

需要 Node 22.6 或更高版本。当前不依赖外部数据库服务：

```bash
./bin/ikb init
./bin/ikb status
./bin/ikb task add --type document --goal "写一份技术方案" --accept "事实都有来源"
```

工作账本默认落在项目内的 `ikb-data/ledger/events.jsonl`，可以直接打开查看；Run 证据位于 `ikb-data/runs/`。`ikb-data/` 已加入 `.gitignore`，其中包括公司相关知识和原始材料，不会被正常提交到 GitHub。完整命令见[完整落地计划](docs/implementation-plan.md)。

### HTML 运行观测

启动本地只读观测页：

```bash
./bin/ikb report serve
```

然后打开 `http://127.0.0.1:3417`。页面每次打开和每 15 秒刷新时都重新读取当前 IKB Ledger，展示 Task/Run 质量、Knowledge 待复核、来源候选、doctor/ledger 和推理确认项；不会把 Source 或 Knowledge 正文发给浏览器以外的服务，也只绑定本机回环地址。端口可用 `--port` 覆盖。

### 持续增量维护

本机维护脚本会用增量游标扫描 Claude/Codex/Desk/Elephant 历史，刷新人物视图、Session Triage 经验队列、知识索引、候选池，并按“滚动 30 分钟最多 10 篇、文档间隔 2 秒”读取当前候选池中的学城文档/评论，最后生成日报和质量门禁；不会向大象或学城发送任何消息/评论/文档写操作。手工运行一次：

```bash
node scripts/ikb-maintenance.mjs daily
```

已提供 macOS LaunchAgent 模板：`scripts/launchd/`。安装后每日任务随登录启动并每 6 小时运行一次，周任务在周日 03:30 生成周报和 Outer Loop 模式摘要：

```bash
mkdir -p "$HOME/Library/LaunchAgents"
cp scripts/launchd/com.htwu.ikb.maintenance.plist "$HOME/Library/LaunchAgents/"
cp scripts/launchd/com.htwu.ikb.maintenance-weekly.plist "$HOME/Library/LaunchAgents/"
cp scripts/launchd/com.htwu.ikb.report.plist "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.htwu.ikb.maintenance.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.htwu.ikb.maintenance-weekly.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.htwu.ikb.report.plist"
```

每次维护的结构化结果在 `ikb-data/maintenance/runs/`，日报在 `ikb-data/reports/`，观测页会自动显示最近一次结果。脚本使用本地锁保证增量任务不会并发覆盖账本；失败会留在维护结果和 HTML 报表中，不会伪装成“已处理”。每日 triage 默认不读取完整 tool output，只把有失败/阻断/重试、人工纠偏、Verifier 驳回、非显然修复、partial/incorrect feedback 或新决策/规则的会话送入 Experience 队列；每周按 `3 个独立 Run` 或 `2 个独立 Run + 真实验证` 生成 `pending_review` 候选，仍需人工补齐 Knowledge Card。

维护本身也进入 Harness：每次 daily/weekly 都创建一个 Task/Run，步骤之间写入 handoff、Artifact 和 Gate 事件；上游失败会阻断下游，只有步骤、doctor、ledger、Verifier 和固定评估全部通过才会得到 `quality=pass`。历史 Run 的 `harness repair` 是独立 Outer Loop 命令，不会被日常维护隐式调用。详细契约见 [维护 Run 契约](docs/维护运行契约.md)。

## Obsidian 知识关系

Obsidian 可以直接打开项目内的 `ikb-data/vaults/personal` 或 `ikb-data/vaults/work`。ikb 为每条知识写入稳定 ID 和 alias，关系字段保持为可点击的 `[[knowledge-id]]`；`related` 和 `contradicts` 自动双向维护，`derived_from` 保持从新知识指向依据的单向关系。

两个 Vault 使用同一套可浏览 collection：`domains / projects / people / concepts / decisions / playbooks / lessons / syntheses`。`type` 表示知识是什么，`collection` 表示人从哪里浏览；例如“某位关键人的评审要求”可以是 `fact + people`。Vault 根目录和每个 collection 的 `index.md`、`governance/<scope>/status.md` 都由 ikb 重建，不参与知识检索。

默认数据目录是当前项目的 `ikb-data/`；可以用 `IKB_HOME` 或 `--home` 覆盖。个人知识和工作知识仍然物理隔离。本地知识按原始证据保存，不做自动脱敏；只有用户明确要对外分享时，才另行导出并按发布规则检查。公司/工作知识不因脱敏就进入 GitHub。

### 知识准入

分析完成后必须明确 `admit` 或 `skip`，不按文章长度判断，也不要求每篇文章凑一条摘要。`admit` 的来源型知识必须说明为什么值得长期保留、什么时候适用、边界在哪里，并保留 Source 引用；`skip` 只生成 rejected Candidate 和账本事件，不写 Obsidian 知识文件。

落盘前 Core 会拒绝空正文、普通正文中的字面量 `\n`/`\r\n`、缺失来源或准入字段。`knowledge lint` 检查指定条目或整个 Vault，失败返回非零；`doctor` 使用同一套规则检查手工编辑后的存量文件。旧知识仍可读取，但来源型旧 draft 必须补齐当前准入信息才能 verified。

```bash
./bin/ikb capture <source-file> --title "标题" --type fact --collection people --scope work --admission-reason "会影响后续判断" --applicability "适用场景" --boundary "不适用场景"
./bin/ikb knowledge skip --title "无长期知识" --reason "只有临时进度，没有可复用结论" --source-id <source-id>
./bin/ikb knowledge lint --scope work
./bin/ikb knowledge relate <from-id> <to-id> --type related
./bin/ikb knowledge relate <from-id> <to-id> --type derived_from
./bin/ikb knowledge relate <from-id> <to-id> --type contradicts
./bin/ikb knowledge rebuild --scope work
./bin/ikb people list --scope work
./bin/ikb people add <mis> --mis <mis> --scope work
./bin/ikb people update <mis> --name "显示名" --uid <uid> --aliases "别名1,别名2"
./bin/ikb people view <mis> --scope work --limit 100
./bin/ikb people rebuild --scope work --limit 100
./bin/ikb candidate discover <source-id> --scope work
./bin/ikb candidate discover-all --scope work
./bin/ikb source search-citadel --keyword "验价" --limit 20 --enqueue --scope work
./bin/ikb candidate list --status discovered --scope work
./bin/ikb candidate update <candidate-id> --status queued
./bin/ikb candidate resolve <candidate-id>
./bin/ikb candidate resolve-all --scope work --limit 10 --delay-ms 2000
```

个人与工作 Vault 默认不能互相建立链接；确实需要跨域时显式加 `--allow-cross-scope`。关系命令是幂等的，重复执行不会产生重复链接；有实际变更才写入 `knowledge.related` 事件。

旧版本写在 `vaults/<scope>/entries/` 的知识继续可读，不会被初始化过程自动移动。确认需要整理时再显式执行 `ikb knowledge migrate --scope <scope>`；命令不会覆盖同名目标，会先写可恢复的迁移 journal，再为每次移动追加幂等的 `knowledge.migrated` 事件。未完成的 journal 会由 `ikb doctor` 报告。

## Agent-facing Skills

项目级 Skills 位于 `.codex/skills/`：

- `ikb-source-intake`：接入大象、Agent 会话、学城文档/评论、重要文档和评审评论，并把原始证据写入 Source；维护流程会自动读取已发现且可访问的学城候选；
- `ikb-conversation-analysis`：分析对话、人物、文档论证和评论反馈；
- `ikb-knowledge-curator`：生成 draft、维护 Obsidian 关系并执行准入门禁。

### Agent 角色与门禁

Agent 不是一组互相独立的机器人，而是由 Harness 编排的流程节点。当前登记六个角色：任务总管、资料采集员、证据分析员、知识策展员、工作执行员、验收审计员。中文名用于人查看，`ikb-*` ID 用于 Run、账本和后续恢复，不随显示名变化。

```bash
./bin/ikb agent list
./bin/ikb agent show ikb-operator
./bin/ikb gate list
./bin/ikb gate show G5
./bin/ikb loop list
./bin/ikb loop show mid
./bin/ikb run start <task-id> --agent ikb-operator --skill coding
./bin/ikb harness eval --json
./bin/ikb harness suite list --json
./bin/ikb harness report --suite work-protocol --json
./bin/ikb harness eval --suite work-run-quality --task-dir .agent-work/<task-id> --json
./bin/ikb harness report --suite work-run-quality --task-dir .agent-work/<task-id> --json
./bin/ikb run evaluate <run-id> --suite ikb-run-quality --json
./bin/ikb harness report --suite ikb-run-quality --run <run-id> --json
./bin/ikb harness repair --suite ikb-run-quality --limit 100 --json
./bin/ikb report daily --json                  # 本地日报：终态、质量、知识使用
./bin/ikb report weekly --json                 # 本地周报：失败聚类和 Outer 候选
./bin/ikb experience triage --scope work --adapter all --limit 500 --json
./bin/ikb experience list --scope work --json
./bin/ikb experience cluster --scope work --min-samples 3 --json
./bin/ikb experience candidate-list --scope work --json
./bin/ikb reasoning run --scope work --json       # 全局推理：自动处理/延后取证/真正待确认
./bin/ikb reasoning show --scope work --json      # 查看最近推理报告
```

Run 启动时会校验 Agent 角色、Task 类型和 Skill 白名单。角色之间通过 Task、Run、Source、Knowledge、Artifact、Approval 和事件账本交接，不通过不可追溯的临时上下文直接放行。三层 Loop 的输入、输出、证据来源和当前状态可由 `ikb loop` 查看；G0～G6 的角色绑定、当前实现状态和待补门禁见[执行与治理契约](docs/contracts.md)。

推理报告是 Knowledge 之上的压缩层：它不会凭数量制造知识，也不会把每个 Draft 的“待确认”都交给用户。已有边界自动处理，实时证据缺口延后到具体 Task，只有人物/高风险规则/外部副作用等不可推断决策进入用户队列；报告和每次生成事件都可回放。

Skill 是 Agent 的主入口，CLI 只提供确定性底座和审计/运维能力。当前直接可用的来源是文本、文件、Markdown，本机 Claude Code/Codex/Desk 历史会话、指定目录的 Elephant 批准导出，以及通过本机 `dx` + 已登录 Chrome CDP 拉取的有界大象会话；学城文档、划词/全文评论读取和学城搜索通过官方 `oa-skills citadel` 接入。聊天或 Agent 中出现的明确学城 URL 会进入输入候选池，并由已授权维护流程自动读取；搜索摘要不会直接进入 Knowledge。所有外部读取都只生成本地快照，不自动发送消息、发布文档或发表评论。

本地 Source Slice：

```bash
./bin/ikb source ingest examples/source/agent-session.jsonl --kind ai_conversation --scope work
./bin/ikb source ingest examples/source/review-comment.md --kind review_comment --scope work
./bin/ikb source ingest ikb-data/staging/catpaw-memory/latest.jsonl --kind manual --adapter catpaw-memory --scope work --sensitivity work-internal
./bin/ikb source ingest-citadel <content-id> --scope work
IKB_ELEPHANT_CDP_URL=http://127.0.0.1:9222 ./bin/ikb source ingest-elephant --gid <group-id> --type group --limit 20 --scope work
# 所有 Source 入口默认支持增量；--no-incremental 才回到整快照
./bin/ikb source ingest-history --adapter codex --scope work --incremental
./bin/ikb source compact-raw --scope work --dry-run     # 检查 raw 快照重复与可共享前缀
# 定时维护会使用 --limit 0 扫描全部历史文件；哈希/游标保证后续只导入增量
./bin/ikb source ingest ikb-data/staging/catpaw-memory/latest.jsonl \
  --kind manual --adapter catpaw-memory --scope work --incremental
# 选定群的网页全量快照：默认没有 100 条上限，直到页面确认“没有更多消息”
node scripts/capture-elephant-browser.mjs --gid <group-id> --name "群名" \
  --output ikb-data/staging/elephant/browser-groups/<date>-gid-<group-id>-full.ndjson
./bin/ikb source person --name <speaker-name> --context-window 2 --scope work
./bin/ikb people view <mis> --scope work --limit 100
./bin/ikb source context <source-id> --limit 100
```
