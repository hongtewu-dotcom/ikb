# ikb

ikb 是面向 Agent 的本地知识库。它只承担三件事：保存原始证据、维护可复用知识、记录知识在真实任务中的使用反馈。

当前主架构只有四个对象：`Source` 保存原始材料，`Knowledge` 保存未来任务可直接复用的结论，`Inbox` 保存仍需整理或确认的事项，`Receipt` 以单一不可变格式记录一次命令或维护的输入、操作和结果。Knowledge 状态只有 `draft / verified / retired`。

Agent 公开入口只有三个意图：

```bash
./bin/ikb remember <path|url|text> --scope personal|work
./bin/ikb use --goal <goal> --accept <acceptance> --scope personal|work
./bin/ikb feedback <usage-id> --outcome helpful|partial|incorrect|unused [--result <path>]
```

Task、Run、Candidate、Experience、QV5 Artifact、Ledger、Harness 和旧运维命令继续作为内部兼容能力存在，不属于目标知识生命周期；默认 HELP 不展示，排障时使用 `./bin/ikb --help --all`。

需要人工确认时，IKB 只给一个内容优先的单页入口。页面直接展示 Agent 将采用的正文、适用条件、边界和确认影响，并给出“确认 A、B、C”这类回复格式；hash、Source refs、Artifact 和文件路径只放机器审计附录。批量确认最多三个主题，也只生成一份 `ikb-human-confirmation-brief.v1`。用户不需要在多个评审单之间跳转，也不需要把完整稿路径再传回 CLI。

## 方案入口

- [产品与架构方案](docs/architecture.md)：系统解决什么问题，知识、执行和控制面如何分工。
- [当前详细架构图](docs/architecture-current.md)：按当前代码重绘的 L0/L1/L2 设计、三层 Loop、Eval Plane、真相源和数据流；可用 [draw.io 文件](docs/architecture-current.drawio) 打开。
- [模块边界与保障](docs/模块边界与保障.md)：说明每个 Plane 的真相源、允许依赖、质量门禁和渐进拆分顺序。
- [知识抽取与人物蒸馏规范](docs/knowledge-extraction.md)：增量输入、周期重建、证据门禁和知识合并规则。
- [Source Plane 设计](docs/source-plane.md)：大象、Agent 会话、文档和评论如何进入 ikb。
- [知识准入与 Agent 原则统一维护方案](docs/IKB知识准入与Agent原则统一维护方案.md)：Source、普通 Knowledge、Principle 与 `AGENTS.md` 最小投影的边界和分阶段改造计划。
- [记忆治理与个人知识发布方案](docs/记忆治理与个人知识发布方案.md)：统一 CatPaw/Codex 记忆、IKB Knowledge、云端记忆和 Daily Copilot 的真相源、Git 与发布边界。
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
- `ikb-data/knowledge/personal/`：个人 Knowledge 的 Obsidian 工作区。
- `ikb-data/knowledge/work/`：工作 Knowledge 的 Obsidian 工作区，只保存在本机项目目录。
- `ikb-data/.system/sources/`：聊天、会话、学城文档/评论的原始快照及标准化记录。
- `ikb-data/inbox/<scope>/documents/`：重要文档和草稿收件箱；每日按文件游标增量导入。
- `ikb-data/inbox/<scope>/review-comments/`：代码、文档评审和修改意见收件箱；与正文分开导入。
- `ikb-data/entities/source-targets.json`：私有来源登记表；维护任务从这里读取本地目录、人物、群组和外部候选策略。
- `ikb-data/staging/catpaw-memory/`：迁移前的 CatPaw 拉取快照兼容区；新 Source 统一写入 `.system/sources`。
- `ikb-data/governance/`：缺口、冲突、复核队列和状态视图，不混进正式知识。
- `ikb-data/governance/<scope>/candidates/pool.jsonl`：输入候选池；记录从聊天、Agent 或学城搜索发现的外部入口、状态、来源和解析结果，不直接等同于知识。
- `ikb-data/.system/sources/aliases.json`：Source 的业务别名登记表；用于按标题、URL 和业务叫法找回原始资料，不改变 Knowledge 准入状态。
- `ikb-data/governance/<scope>/sources/`：长期引用 manifest 和 lint 报告；检查 `AGENTS.md`、Skill、Knowledge 或治理文档中的关键资料引用能否解析。
- `ikb-data/governance/<scope>/principles/`：Principle 到 `AGENTS.md` 的只读投影漂移报告；不自动改写启动规则。
- `ikb-data/entities/people/key-people.json`：关键人物目录，只保存在本机，供人物视图和后续人物分析使用。
- `ikb-data/.system/cache/people/<scope>/<person-id>/index.md`：跨来源人物证据视图，可重建，不作为 Knowledge 真相源。
- `ikb-data/.system/ledger/`：Task、Run、Source、Knowledge 变更的可校验事件账本。
- `ikb-data/.system/runs/`：一次 Task/Agent 执行产生的 Context、草稿和验证证据。
- `ikb-data/experiences/`：Session Triage 的 Episode 记录、不可变语义 Analysis revision、分析专属验证和 `pending_review` Knowledge Candidate；任何一层都不等于正式 Knowledge。
- `publications/personal/`（目标结构）：经过发布门禁生成的个人知识 Markdown 与 Manifest，可进入 Git；不是第二个可编辑 Vault。

`ikb-data/` 是运行数据目录，已被 Git 忽略；它不是项目文档目录，也不应上传到 GitHub。`examples/` 只放不来自真实工作数据的合成样例。

## 当前判断

- Obsidian 作为知识工作台，Markdown 才是知识真相源。
- 真实个人知识与工作知识物理隔离；Source、工作知识和个人私有知识不进 Git。经发布门禁生成的个人知识投影可以提交 GitHub，公开仓不保存其私有证据链。
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
./bin/ikb remember ./docs/example.md --scope work
./bin/ikb use --goal "写一份技术方案" --accept "事实都有来源" --scope work
```

工作账本默认落在项目内的 `ikb-data/.system/ledger/events.jsonl`，Run 证据位于 `ikb-data/.system/runs/`。`ikb-data/` 已加入 `.gitignore`，其中包括公司相关知识和原始材料，不会被正常提交到 GitHub。完整命令见[完整落地计划](docs/implementation-plan.md)。

### HTML 运行观测

启动本地只读观测页：

```bash
./bin/ikb report serve
```

然后打开 `http://127.0.0.1:3417`。页面每次打开和每 15 秒刷新时读取当前状态指纹；Ledger、候选、推理或治理文件未变化时直接复用内存快照，变化后再生成一次紧凑 Dashboard。页面展示 Task/Run 质量、Knowledge 待复核、来源候选、Experience 分析队列、人物周期门禁和最近一次 doctor/ledger 完整校验。待复核 Knowledge 与 Candidate 的标题可以点击；供人决定的当前入口统一写入 `ikb-data/inbox/<scope>/confirmations/`。详情页只读、转义正文并拒绝符号链接或路径穿越；服务只绑定本机回环地址，不向外部发送 Source 或 Knowledge。端口可用 `--port` 覆盖。

Agent 或脚本只想判断最近一次完整校验是否仍有效时，不要展开体积很大的 `doctor --json`，直接读取紧凑快照：

```bash
./bin/ikb health --json
```

结果只包含状态、计数、问题数量和时间，不包含 Source、Knowledge 或问题正文。`state=ok` 退出 0；账本在最近完整校验后发生变化时返回 `state=stale`，doctor/ledger 本身失败时返回 `state=error`，两者都非零退出。需要刷新时仍执行完整门禁：`doctor --write-summary --compact` 和 `ledger verify --write-summary`；紧凑健康快照不是完整审计的替代品。维护 Run Artifact 只保存健康快照或紧凑计数，不保存完整 doctor、人物重建或来源导入 JSON。

### 持续增量维护

当前定时职责已经拆开：

| 任务 | 频率 | 写入边界 |
|---|---|---|
| `source-sync` | RunAtLoad，之后每 6 小时 | 同步已登记本地 Source、增量历史并刷新 Inbox；不写 Knowledge，只写一份 Receipt |
| `semantic-maintenance` | 每天 10:30，由 Codex automation 执行 | 最多处理三个有消费者的 Inbox 主题；Principle 只产出 diff；整批只写一份 Receipt |
| `weekly-housekeeping` | 每周一 03:30 | Source 覆盖、失败趋势、缓存和备份清理候选；不写 Knowledge，只写一份 Receipt |
| `report-server` | 常驻，可选 | 只读投影，不保存真相 |

手工验收入口：

```bash
node scripts/ikb-maintenance.mjs source-sync --dry-run
node scripts/ikb-maintenance.mjs source-sync
node scripts/ikb-maintenance.mjs semantic-maintenance --decisions <ikb-semantic-maintenance.v1.json>
node scripts/ikb-maintenance.mjs weekly-housekeeping
```

运行摘要位于 `ikb-data/.system/maintenance/`，唯一 Receipt 位于 `ikb-data/.system/receipts/`。旧 `daily/weekly` 参数仅作调度切换兼容，分别映射到 `source-sync/weekly-housekeeping`；旧 20 步 runner 和 Task/Run/Harness 维护链只保留 internal，不再被默认入口或 LaunchAgent 调用。

<details>
<summary>旧 internal maintenance 兼容说明</summary>

`daily` 和 `weekly` 参数只为旧调用方保留，分别映射到 `source-sync` 和 `weekly-housekeeping`：

```bash
node scripts/ikb-maintenance.mjs daily
node scripts/ikb-maintenance.mjs weekly
```

旧 20 步 Task/Run/Harness 链只用于读取历史 Run 和回归测试，不再有默认 CLI 或 LaunchAgent 入口。macOS LaunchAgent 模板位于 `scripts/launchd/`；安装后 source-sync 随登录启动并每 6 小时运行，weekly-housekeeping 在周一 03:30 运行：

```bash
mkdir -p "$HOME/Library/LaunchAgents"
cp scripts/launchd/com.htwu.ikb.maintenance.plist "$HOME/Library/LaunchAgents/"
cp scripts/launchd/com.htwu.ikb.maintenance-weekly.plist "$HOME/Library/LaunchAgents/"
cp scripts/launchd/com.htwu.ikb.report.plist "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.htwu.ikb.maintenance.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.htwu.ikb.maintenance-weekly.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.htwu.ikb.report.plist"
```

当前摘要写入 `ikb-data/.system/maintenance/`，LaunchAgent 日志写入 `ikb-data/.system/cache/logs/`，锁也位于 `.system/maintenance/`。旧 `maintenance/`、`reports/`、`staging/` 和 `experiences/` 仅作历史兼容；未通过删除审计前不清理。详细边界见 [维护 Run 契约](docs/维护运行契约.md)。

</details>

## Obsidian 知识关系

Obsidian 可以直接打开项目内的 `ikb-data/knowledge/personal` 或 `ikb-data/knowledge/work`。ikb 为每条知识写入稳定 ID 和 alias，关系字段保持为可点击的 `[[knowledge-id]]`；`related` 和 `contradicts` 自动双向维护，`derived_from` 保持从新知识指向依据的单向关系。

两个 Knowledge 工作区使用同一套可浏览 collection：`domains / projects / people / concepts / decisions / playbooks / lessons / syntheses`。`type` 表示知识是什么，`collection` 表示人从哪里浏览；例如“某位关键人的评审要求”可以是 `fact + people`。根目录和每个 collection 的 `index.md`、`governance/<scope>/status.md` 都由 ikb 重建，不参与知识检索。

默认数据目录是当前项目的 `ikb-data/`；可以用 `IKB_HOME` 或 `--home` 覆盖。个人知识和工作知识仍然物理隔离。本地知识按原始证据保存，不做自动脱敏；只有用户明确要对外分享时，才另行导出并按发布规则检查。公司/工作知识不因脱敏就进入 GitHub。

### 知识准入

分析完成后必须明确 `admit` 或 `skip`，不按文章长度判断，也不要求每篇文章凑一条摘要。`admit` 的来源型知识必须说明为什么值得长期保留、什么时候适用、边界在哪里，并保留 Source 引用；`skip` 只生成 rejected Candidate 和账本事件，不写 Obsidian 知识文件。

落盘前 Core 会拒绝空正文、普通正文中的字面量 `\n`/`\r\n`、缺失来源或准入字段。`knowledge lint` 检查指定条目或整个 Vault，失败返回非零；`doctor` 使用同一套规则检查手工编辑后的存量文件。旧知识仍可读取，但来源型旧 draft 必须补齐当前准入信息才能 verified。

正式个人知识还必须使用 `quality_version >= 4` 并通过类型化准入：偏好、目标、事实、决策、playbook、lesson、synthesis 和人物观察分别有不同的证据与验证条件。旧 personal draft 只作为 advisory，不能直接 verified 或公开发布；统一实现位于 `src/knowledge/personal-admission.ts`。

新形成的正式来源型知识使用 QV5 低损耗链路。Analyst 先保存 `knowledge-extraction-manifest`、`knowledge-extraction-result` 和 `knowledge-extraction-fidelity` 三类 Artifact；Core 重新计算 Source 单元处置、参考事实召回、最终 View 事实保留、主张支持、问题覆盖和冲突暴露，不信任文件里预先写好的 `publishable`。Curator 只能选择一个通过门禁的 Case/Product，并把确定性 `product-view` 原字节作为 Knowledge 正文；评审稿若删掉事实、改写正文、引用另一个 Product、使用不存在的 Artifact，或与重新计算的损耗报告不一致，评审包会被拒绝。`canonical_key` 保证同一范围、对象、产品类型和适用边界只有一个活动版本。

`capture` 和 `ingest` 仍保留为手工笔记、兼容旧稿和本地实验入口，不能替代 QV5 正式评审链路；新的 Experience 评审包只接受 QV5。旧 QV4 知识可以继续作为 draft advisory 使用，但不能因为 lint 通过就宣称已经完成低损耗重编译。

个人知识公开发布还要经过第二道门。当前 `publish build` 只在私有 `ikb-data/publications/` 生成确定性的 Bundle、Manifest 和渠道输出，不写 Git 目录、不 commit、不 push；work、private、draft、仅 `source_confirmed`、已过期或含内部信息的 Knowledge 会在写发布目录前阻断。`personal-github` 和 `daily-copilot` 两个 Adapter 均已可用；Daily Copilot 还要求传入完整覆盖 legacy ID、分类和附件处置的私有迁移清单。真正的 `publish release` 尚未开放。

```bash
./bin/ikb capture <source-file> --title "标题" --type fact --collection people --scope work --admission-reason "会影响后续判断" --applicability "适用场景" --boundary "不适用场景"
./bin/ikb knowledge skip --title "无长期知识" --reason "只有临时进度，没有可复用结论" --source-id <source-id>
./bin/ikb knowledge lint --scope work
./bin/ikb source receipt <source-id> --json
./bin/ikb source alias-add <source-id> --alias "业务别名" --json
./bin/ikb source lookup "标题、学城 URL 或业务别名" --scope work --json
./bin/ikb source reference-lint --manifest <reference-manifest.json> --write --json
./bin/ikb knowledge principle-projection-check --manifest <projection-manifest.json> --write --json
./bin/ikb knowledge relate <from-id> <to-id> --type related
./bin/ikb knowledge relate <from-id> <to-id> --type derived_from
./bin/ikb knowledge relate <from-id> <to-id> --type contradicts
./bin/ikb knowledge rebuild --scope work
./bin/ikb publish build --channel personal-github --knowledge-id <personal-public-verified-id>
./bin/ikb publish build --channel daily-copilot --migration-manifest <private-migration-manifest.json>
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
./bin/ikb candidate resolve-all --scope work --limit 10 --delay-ms 30000
```

个人与工作 Vault 默认不能互相建立链接；确实需要跨域时显式加 `--allow-cross-scope`。关系命令是幂等的，重复执行不会产生重复链接；有实际变更才写入 `knowledge.related` 事件。

旧版本写在 `vaults/<scope>/entries/` 的知识继续可读，不会被初始化过程自动移动。确认需要整理时再显式执行 `ikb knowledge migrate --scope <scope>`；命令不会覆盖同名目标，会先写可恢复的迁移 journal，再为每次移动追加幂等的 `knowledge.migrated` 事件。未完成的 journal 会由 `ikb doctor` 报告。

## Agent-facing Skills

项目级 Skills 位于 `.codex/skills/`：

- `ikb-source-intake`：接入大象、Agent 会话、学城文档/评论、重要文档和评审评论，并把原始证据写入 Source；维护流程会自动读取已发现且可访问的学城候选；
- `ikb-conversation-analysis`：分析对话、人物、文档论证和评论反馈；
- `ikb-knowledge-curator`：生成 draft、维护 Obsidian 关系并执行准入门禁；
- `ikb-use-knowledge`：让本地 Agent 在编码、评审、CR、写文档和沟通任务中按 Task scope 读取 Context Pack，区分“召回”和“真实采用”，并回传 helpful/partial/incorrect/unused；审阅后发现错误但未采用时保留为 `unused + reviewFinding=incorrect`，不伪造使用记录。

### Agent 角色与门禁

Agent 不是一组互相独立的机器人，而是由 Harness 编排的流程节点。当前登记六个角色：任务总管、资料采集员、证据分析员、知识策展员、工作执行员、验收审计员。中文名用于人查看，`ikb-*` ID 用于 Run、账本和后续恢复，不随显示名变化。

```bash
./bin/ikb agent list
./bin/ikb agent show ikb-operator
./bin/ikb gate list
./bin/ikb gate show G5
./bin/ikb loop list
./bin/ikb loop show mid
./bin/ikb run start <task-id> --agent ikb-operator --skill ikb-use-knowledge
./bin/ikb run plan <run-id> --file <plan.json>
./bin/ikb context <task-id> --run <run-id> --scope personal|work

# 将 CatPaw Memory Topic Index 审计并按每 Run 最多 3 个主题迁移为 QV5 draft Knowledge
./bin/ikb knowledge memory-topic-audit --index ~/.catpaw/memory/MEMORY.md --write
./bin/ikb knowledge memory-topic-sync --index ~/.catpaw/memory/MEMORY.md --run <run-id> --offset 0 --limit 3
./bin/ikb knowledge memory-topic-revise --index ~/.catpaw/memory/MEMORY.md --analyst-run <analysis-run-id> --curator-run <curation-run-id> --offset 0 --limit 3
./bin/ikb knowledge use <knowledge-id> --run <run-id> --artifact <artifact-id> --purpose check --note "用于形成验收检查项"
./bin/ikb knowledge feedback <knowledge-id> --run <run-id> --outcome helpful --reason-code improved_check --evidence <artifact-id>
./bin/ikb knowledge feedback <knowledge-id> --run <run-id> --outcome unused --review-finding incorrect --reason-code source_conflicts_with_current_state --note "审阅发现来源与当前一手事实冲突，未写入交付物" --evidence <artifact-id>
./bin/ikb knowledge usage-status --run <run-id> --json
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
./bin/ikb experience context <experience-id> --run <analyst-run-id> --json
./bin/ikb experience list --scope work --json
./bin/ikb experience cluster --scope work --min-samples 3 --json
./bin/ikb experience candidate-list --scope work --json
./bin/ikb experience candidate-review <candidate-id> --draft <artifact-id> --validation <artifact-id> --guide <artifact-id> --json
./bin/ikb experience candidate-review-show <candidate-id> --json
./bin/ikb reasoning run --scope work --json       # 全局推理：自动处理/延后取证/真正待确认
./bin/ikb reasoning show --scope work --json      # 查看最近推理报告
```

Run 启动时会校验 Agent 角色、Task 类型和 Skill 白名单。角色之间通过 Task、Run、Source、Knowledge、Artifact、Approval 和事件账本交接，不通过不可追溯的临时上下文直接放行。三层 Loop 的输入、输出、证据来源和当前状态可由 `ikb loop` 查看；G0～G6 的角色绑定、当前实现状态和待补门禁见[执行与治理契约](docs/contracts.md)。

推理报告是 Knowledge 之上的压缩层：它不会凭数量制造知识，也不会把每个 Draft 的“待确认”都交给用户。已有边界自动处理，实时证据、策略和外部动作延后到具体 Task；`pending_review` Candidate 先留在 Curator 队列。候选只有在主张和使用边界收敛、证据可回放、内容验证通过，并登记一个绑定当前 Candidate hash 的完整评审包后，才进入即时用户队列。评审包必须来自同一 `ikb-knowledge-curator` Run，包含完整知识稿、验证报告和讲人话确认说明；reasoning 和本地 HTML 只展示这些登记且 hash 未变化的文件。人物身份或稳定观察边界仍不能由模型自行决定。报告和每次生成事件都可回放。

Context Pack 必须绑定已有 Task 和 Run，并强制继承 Task 的 `personal/work` scope；调用方传入不一致的 scope 会被拒绝。每一版 Context Pack 按内容 hash 写入不可变文件、自动登记 Artifact 和 `produced` lineage，`context-pack.md` 只是最新投影。检索结果同时受相对相关度和正文总预算约束，卡片处于修订 hold 或 retired 时不会进入 Agent 上下文。

每次 `search` 和 `context` 都会在本地 Ledger 记录查询，零结果也会保留。Context 只表示知识被召回；真正影响交付物时必须用 `knowledge use` 绑定同一 Run 的 Artifact，并写清影响了哪个决定、段落、检查或行动。普通 `incorrect` 表示知识已经实际采用，随后被一手证据判错；审阅阶段发现错误但未采用时，用 `unused` 加 `--review-finding incorrect`，它必须已有引用、没有 `knowledge use`、带非空原因码和说明，并绑定同一 Run、hash 仍有效的 Artifact。采用新契约的 Run 在成功结束前，所有引用都必须分类为 `helpful / partial / incorrect / unused`，且四种结果都要有同 Run Artifact 证据。`usage-status` 会单列 `reviewedIncorrectUnadoptedKnowledgeIds` 和 `reviewedIncorrectUnadoptedKnowledgeCount`；日报、周报和本地 HTML 在 `knowledgeUsage.feedbackReviewFindings.incorrect` 聚合这类审阅拒绝，不会增加普通 `feedback.incorrect`。完整语义见[知识查询、使用与效果留痕契约](docs/知识查询使用效果留痕契约.md)。

Task 标题是 Context Pack 的主题锚点，应该直接写清“对象 + 动作”，例如“机票预订架构评审”。任务确实需要两个维度时，要保留两个完整短语，例如“技术项目向上汇报与里程碑同步”，不能压成会丢词义的新短语。检索先用标题、目标和验收召回宽候选，再用标题词命中 Knowledge 的标题、`use_when` 或 `questions_answered`，避免很长的验收文字把无关卡片挤进结果。标题锚点已命中时使用固定小下限和结果上限，不按中文长标题最高分的比例裁掉其他明确维度；标题完全无命中时才对宽候选使用相对阈值。目标和验收仍用于正文证据召回与片段选择，不会被丢弃。

`run plan` 接收一个非空 DAG；步骤事件出现后计划不可再改。例如：

```json
{
  "steps": [
    { "id": "retrieve-context", "depends_on": [] },
    { "id": "do-work", "depends_on": ["retrieve-context"] },
    { "id": "verify", "depends_on": ["do-work"] }
  ]
}
```

Experience Knowledge Candidate 使用 `pending_review → accepted/rejected → applied` 生命周期。接受新增或修订候选时，确认对象不是一句摘要，而是完整知识稿：

```bash
./bin/ikb experience candidate-decide <candidate-id> \
  --decision accept --reason "接受这份完整知识稿及适用边界" --file <完整知识稿.md>
# 新增知识：不传 --primary
./bin/ikb knowledge apply-candidate <candidate-id> \
  --file <完整知识稿.md>
# 修订或合并旧知识：指定保留的主 Knowledge
./bin/ikb knowledge apply-candidate <candidate-id> \
  --file <完整知识稿.md> --primary <保留的-knowledge-id>
./bin/ikb knowledge revision-list
./bin/ikb knowledge revision-recover <revision-id>
./bin/ikb knowledge correction-request <knowledge-id> --run <run-id> --artifact <artifact-id> --action <revise|retire> --reason "<可复核的纠错原因>"
./bin/ikb knowledge qv5-resolve-hold <candidate-id> --revision <revision-id>
```

接受时系统保存不可变确认快照和 SHA-256；应用时再次核对候选、确认快照、完整稿、scope、类型、collection、Source 谱系和目标 Vault 路径。修订 Candidate 的类型和 collection 还必须与目标卡一致，多个合并目标也必须先收敛到同一知识形状。新增知识以确认过的原字节写成 `draft`，若进程在写文件后中断，重跑会识别相同文件并补齐索引、账本和 Candidate 状态；同 ID 不同内容绝不覆盖。修订知识还会核对 before/after revision 和 journal。用户确认后文件发生变化、目标被并发修改或 journal 被重定向时，事务会在覆盖前阻断。拒绝候选不生成 Knowledge；未确认候选不会自动改写 Vault。

发现能直接否定既有卡片的 P0 反例时，先用 `knowledge correction-request` 隔离，而不是直接编辑卡片。它只接受同一 Run 中已登记、完整且当前字节/hash 可校验的 Artifact，并要求该 Run 所属 Task 的 scope 与目标 Knowledge scope 相同；相同目标、Run、Artifact、动作和原因会幂等复用同一个 `pending_review` correction Candidate。该请求绝不改动目标卡的正文、status 或 revision。`pending_review` 和已接受的 `accepted` revise/retire Candidate 都会自动形成 retrieval hold，默认 `search` 和 `context` 不召回目标卡。`verified/user_confirmed` 卡也只能生成完整评审包，等待人工决定，不能静默覆盖。

完成替换稿的 QV5 revision 后，才可运行 `knowledge qv5-resolve-hold`。该命令仅在 Candidate 仍为 `accepted`、唯一目标和 scope 与 revision journal 一致、当前 reviewed Artifact hash 与 journal 导出的 replacement Artifact hash 一致、journal 已 `completed`，且当前卡字节仍等于 journal 的 `afterHash` 时，将 Candidate 标为 `applied` 并解除 hold。任一条件不符均 fail-closed，保留 hold，不会让旧卡重新进入默认检索。

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
./bin/ikb source target-list                         # 查看私有来源登记表
./bin/ikb source sync-targets                        # 增量同步四个文档/评论收件箱
./bin/ikb source coverage --scope work --write       # 生成已覆盖/无可见消息/真实欠账三分账
./bin/ikb source compact-raw --scope work --dry-run     # 检查 raw 快照重复与可共享前缀
# 定时维护会使用 --limit 0 --summary 扫描全部历史文件；未变化文件不会重新解析，输出也只保留变化项
./bin/ikb source ingest ikb-data/staging/catpaw-memory/latest.jsonl \
  --kind manual --adapter catpaw-memory --scope work --incremental
# 选定群的网页全量快照：默认没有 100 条上限，直到页面确认“没有更多消息”
node scripts/capture-elephant-browser.mjs --gid <group-id> --name "群名" \
  --output ikb-data/staging/elephant/browser-groups/<date>-gid-<group-id>-full.ndjson
./bin/ikb source person --name <speaker-name> --context-window 2 --scope work
./bin/ikb people view <mis> --scope work --limit 100
./bin/ikb source context <source-id> --limit 100
```
