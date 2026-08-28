# IKB 精简架构与落地方案

> 基线：2026-08-27 本地最新版，仓库为 /Users/htwu/projects/_personal/ikb。
> 文档性质：目标架构、实施顺序与 2026-08-27 实施记录。
> 当前边界：五批已落地；三张冲突 Principle 已完成人工确认，目录迁移和迁移后 source-sync 已通过。历史删除门槛未满足，因此保留所有兼容数据。

## 结论

IKB 只做三件事：保存原始证据、维护可复用知识、让 Agent 在真实任务中使用并反馈。现有方案把 Source、Candidate、Experience、Analysis、Compilation、QV5、Task、Run、Artifact、Evaluation 和多类投影都放进主流程，过程对象多于用户真正关心的对象。

目标架构只保留两个真相对象、一个待办队列和一种不可变收据：

| 对象 | 回答的问题 | 真相源 |
|---|---|---|
| Source | 原始材料是什么、来自哪里、哪个版本 | `.system/sources` |
| Knowledge | 未来任务可以直接复用什么 | `knowledge` |
| Inbox | 哪件事还需要整理、更新或人工确认 | `inbox` |
| Receipt | 一次命令或维护发生了什么、输入输出是什么、谁确认了什么 | `.system/receipts` |

Knowledge 只有三个状态：

| 状态 | 含义 | 默认召回 |
|---|---|---|
| draft | 证据或确认尚未满足 | 否 |
| verified | 可以给普通任务使用 | 是 |
| retired | 已失效或被替代 | 否 |

helpful、incorrect、source_confirmed、user_confirmed、hold、superseded 和 pending_review 都不再进入 Knowledge 状态机。它们分别是反馈、收据事实、检索行为、关系或 Inbox 事项。现有字段可以保留兼容，但 Agent 不需要理解多套状态。

Inbox 也不建状态机：文件存在表示待处理；处理完成后写 Receipt，再移出 Inbox。Task/Run 保留为内部执行兼容，不属于知识生命周期。

## 目标架构全景

```text
学城 / 本地文档 / Agent 会话 / 用户明确输入
                     ↓ remember
                  Source
                     ├──────────────┐
                     ↓              │ Source fallback
                   Inbox            │
                     ↓ IKB Agent     │
              new / update / ignore │
                     ↓              │
                 Knowledge ─────────┤
                     ↓ use          │
                   Context ◀────────┘
                     ↓
                真实 Agent Task
                     ↓ feedback
              usage result + feedback
                     └──── partial / incorrect / zero result ───→ Inbox

verified Principle ──→ AGENTS managed block
Source / Knowledge / Receipt ──→ index / dashboard / health

every 6h source-sync ──→ Source + Inbox + Receipt
daily semantic-maintenance ──→ IKB Agent
weekly housekeeping ──→ Receipt + cache cleanup candidates
```

目标架构完整边界如下：

| 层 | 包含什么 | 写入方 | 消费方 | 是否有业务状态 |
|---|---|---|---|---|
| 输入 | 文档、会话、代码或运行证据、用户明确材料 | remember / Source sync | Source | 否 |
| 证据 | Source 原文、版本、定位、hash | Source intake | IKB Agent、回源查询 | 否，只追加版本 |
| 待办 | Inbox 项及触发原因 | sync、zero result、feedback | IKB Agent、人审 | 否，存在即待处理 |
| 知识 | Entry、Fact、Guide、Principle | IKB Agent，经准入后写入 | Agent Context | 仅 draft/verified/retired |
| 使用 | Context、实际 uses、Result、feedback | Agent CLI | 知识维护 | 否，都是不可变收据 |
| 审计 | Receipt、人工确认、before/after hash | 各命令的唯一 writer | 恢复、审查、反馈 | 否 |
| 投影 | index、dashboard、health、AGENTS block | 确定性重建 | 人、Agent runtime | 否，可删除重建 |
| 内部兼容 | Task/Run、Ledger、旧 QV5 Artifact、cache | 现有实现 | 排障与迁移 | 不进入知识状态机 |

Source 和 Knowledge 是内容真相。Inbox 只表示还有事要处理，Receipt 只说明已经发生了什么；Context、index、dashboard 和 AGENTS block 都可以从真相重建。旧 Task/Run、Experience、Candidate、Analysis 和 QV5 继续可读，但不再决定目标流程。

Receipt 只有一个格式：`kind` 说明是 remember、usage、feedback、knowledge maintenance、source sync 还是 weekly；`operations[]` 记录本次零到多个动作及其 input refs、before/after hash、outcome 和人工确认。kind 是事件类型，不是状态，也不产生新的目录和工作流。一次命令或一次定时运行最多写一份 Receipt。

## 最小循环

```text
Source / Knowledge
       ↓
Agent 取得 Context
       ↓
真实任务使用
       ↓
Result + feedback
       ↓
new / update / keep / retire
       ↓
Knowledge
```

重要材料先进入 Source，不要求当场生产 Knowledge。Agent 做任务时优先拿 verified Knowledge；没有合适知识时，可以回退 Source，但必须标记“原始材料，尚未整理”。任务结束只记录实际使用和 feedback，不根据检索命中自动判断 helpful。

zero result、partial、incorrect、Source 更新或用户明确要求会生成 Inbox 项。IKB Agent 对照现有 Knowledge 做 new、update、keep 或 retire；完成后回到同一个 Knowledge 文件和同一个 ID。循环是否有效只看后续独立任务，不看 maintenance 是否成功。

incorrect 会把对应 Knowledge 退回 draft 并进入 Inbox；partial 在已知部分仍正确时可以保持 verified，同时生成更新项。只有确认整体失效或被替代时才进入 retired。

## 知识怎样生产

生产流程压成五步：

```text
保存 Source
  → 对照现有 Knowledge
  → new / update / keep / ignore
  → 校验或人工确认
  → 写 Knowledge + 一份 Receipt
```

每次生产只保留一份 Receipt；批量维护最多处理三个主题，把各主题放在同一份 `operations[]` 中。收据内容包括 Source 版本、目标 Knowledge、before/after hash、适用边界、校验结果，以及必要时的人审决定。当前 inventory、manifest、result、fidelity、product-view、validation 和 revision journal 不再作为七个流程节点；新流程把必要字段收进一份收据。旧 QV5 Artifact 保持只读兼容，不批量回写。

准入只按内容风险分三类：

| 内容 | 进入 verified 的条件 |
|---|---|
| 客观事实 | 权威 Source 可定位，正文没有超出来源，适用边界明确 |
| Guide | 步骤、检查和停止条件完整，并经过一次真实任务或人工确认 |
| Principle | 人确认精确正文、范围和例外 |

证据冲突、来源过时或包含推断时保持 draft，进入 Inbox。没有明确未来任务的问题只保存 Source，不生成 Knowledge。

## Knowledge 写多少

Knowledge 不按统一字数验收，只保留四种写法：

| 写法 | 用途 | 正文最低内容 |
|---|---|---|
| Entry | 找到当前真源 | 入口作用、稳定地址、动态回读方式、不保存什么 |
| Fact | 回答业务、架构或决策问题 | 当前结论、对象关系、适用范围、例外、Source |
| Guide | 执行操作或避免踩坑 | 触发条件、步骤、检查、停止条件、失败出口 |
| Principle | 改变 Agent 的判断 | 指令、触发条件、范围、例外、淘汰条件 |

Entry 可以很短。Fact 必须直接回答问题，不能只给目录链接。Guide 不能压成一句经验。Principle 的完整语义留在 IKB，AGENTS.md 只保留每次运行必须立即生效的短投影。

原文、完整会话和大段证据留在 Source。Knowledge 只写任务需要的当前结论和边界，但不能把关键步骤、例外或检查藏到无人读取的 Artifact 中。

## Principle 与 AGENTS.md

Principle 仍是 Knowledge，只使用 draft、verified、retired 三个状态。它和普通事实的区别只有一条：进入 verified 前必须由人确认精确正文。Agent 可以整理候选、指出冲突和生成 diff，不能替人确认。

AGENTS.md 是 verified Principle 的短投影。只有遗漏后会导致越权、破坏性操作、责任丢失或验收失真的规则才投影；完整依据、范围、例外和淘汰条件仍在 IKB。投影检查只报告缺失、漂移和已退役规则，不自动改文件。

三张通用 Principle 的 verified 与正文 pending_review 冲突已处理。用户逐项确认 A、B、C 后，语义维护按提议稿更新三张卡并写 Receipt；补齐 Receipt 确认链后，三张卡均为 revision 2，可被默认检索，AGENTS 投影 4/4 current。后续 Principle 变更继续先出一份内容优先的单页确认稿，人确认点名项后再更新，不能直接手改冲突段落。

## Agent CLI

`bin/ikb` 只面向 Agent/Skill。人看 knowledge、inbox、archive、评审包和 dashboard；maintenance、report、备份和恢复是内部脚本，不属于公开 CLI。

公开 CLI 只保留三个意图：

```text
ikb remember <path|url|text> --scope <scope>
ikb use --goal <goal> --accept <acceptance> --scope <scope>
ikb feedback <usage-id> --outcome helpful|partial|incorrect|unused [--result <path>]
```

- remember 保存或复用 Source，返回 Source ID、版本和 Knowledge 覆盖情况。
- use 检索 Knowledge，必要时回退 Source，内部兼容现有 Task/Run，外部只返回 usageId 和 Context。
- feedback 登记结果、实际使用和反馈，结束本次 usage；系统不自动推断 helpful。

Source、search、knowledge、task、run、artifact、extraction、candidate、experience、doctor、ledger、storage、backup、restore 和 Harness 命令先保留为 internal。默认 HELP 不展示，`--help --all` 才用于排障。`role`、`run follow`、`ledger rebuild`、顶层 `show` 和重复 Run 终态别名在引用清零后删除。

Skill 继续使用现有 `--json`。退出码保持 0=成功、2=结果需关注、1=参数或运行错误；maintenance/report 先解析 stdout JSON，再判断退出码，避免 exit 2 的诊断丢失。不增加 json-v2、Command Registry 或新的 Application Plane。

## 改造前定时任务基线

以下内容是切换前的盘点基线，用于解释为什么拆分维护职责，不再代表当前已安装配置。本机一直没有 IKB cron；当时有三项 LaunchAgent 和一项 Codex automation，名称中的 `daily` 不等于每天一次。

| 切换前任务 | 当时频率 | 当时动作 | 修正原因 |
|---|---|---|---|
| `com.htwu.ikb.maintenance` | 登录即跑，此后每 6 小时 | 执行 `ikb-maintenance.mjs daily` 的 20 个串行步骤 | 名称误导；把同步、语义生产、健康检查和报告混在一条硬链 |
| `com.htwu.ikb.maintenance-weekly` | 每周一 03:30 | 在 daily 20 步后再跑 3 个 weekly 步骤 | README 写成周日，与已安装 plist 不一致 |
| `com.htwu.ikb.report` | 登录即启动，异常后常驻拉起 | 运行 3417 端口的只读报告服务 | 它是常驻投影，不是 daily batch |
| Codex `IKB 每周三语义维护` | 每周三 10:30 | 让 Agent 跑旧 Task/Run/Plan/Artifact/QV5 流程 | prompt 仍指向已失效的 `/Users/htwu/projects/ikb`，目标链路也已过时 |

配置文件的完整路径保持为 `/Users/htwu/Library/LaunchAgents/com.htwu.ikb.maintenance.plist`、`/Users/htwu/Library/LaunchAgents/com.htwu.ikb.maintenance-weekly.plist`、`/Users/htwu/Library/LaunchAgents/com.htwu.ikb.report.plist` 和 `/Users/htwu/.codex/automations/ikb/automation.toml`；其内容已在后续切换中更新。

切换前 `daily` 的 20 个步骤按下表逐项处置，而不是只改任务名字：

| # | 当前步骤 | 目标处置 |
|---:|---|---|
| 1 | `home-init` | 保留，合入 Source sync |
| 2 | `local-memory-sync` | 保留，合入 Source sync |
| 3 | `registered-files-sync` | 保留，合入 Source sync |
| 4 | `source-ingest` | 保留，合入 Source sync |
| 5 | `agent-team-observe` | 移出日常主链，只作按需遥测 |
| 6 | `source-raw-dedup` | 改为写入时去重；历史压缩放到 weekly |
| 7 | `experience-triage` | 并入 Inbox refresh |
| 8 | `experience-analysis-queue` | 并入 Inbox refresh，不再维护第二条队列 |
| 9 | `candidate-discover` | 并入 Inbox refresh |
| 10 | `candidate-resolve` | 外部材料只在显式 Source intake 时解析，不自动远端补全 |
| 11 | `source-coverage` | 移到 weekly 摘要 |
| 12 | `people-rebuild` | 按需或 weekly；只能生成投影或 Inbox 项 |
| 13 | `people-readiness` | 并入 people 投影检查，不阻断 Source sync |
| 14 | `knowledge-rebuild` | 仅在 Knowledge 真正变更后执行 |
| 15 | `knowledge-archive` | retire 事件发生时执行，不做每日扫库 |
| 16 | `knowledge-lint` | 仅校验本次变更 |
| 17 | `reasoning` | 交给每日语义维护，每次最多三个主题 |
| 18 | `doctor` | 失败时或 weekly 执行，不作每次硬门禁 |
| 19 | `ledger` | 写 Receipt 时同步追加；完整 verify 按需执行 |
| 20 | `report` | 从最新 Receipt 重建视图，不产生独立流程产物 |

weekly 额外的 `weekly-report` 收敛为一份周摘要；`experience-cluster` 和 `outer-patterns` 不再进入固定流水线，只有出现明确消费者时才运行。

## 当前定时任务合同

当前只有一项周期性确定性写任务、一项每日 Agent 语义维护、一项每周整理和一项可选只读服务。仓库模板与已安装配置已经按下表切换；目录迁移后的 source-sync RunAtLoad 与 report-server 已真实运行。Codex automation 的配置已激活，下一次宿主运行是 2026-08-28 10:30:18，尚未到观察时间。

| 当前任务 | 频率 | 唯一职责 | 每次产物 |
|---|---|---|---|
| `source-sync` | 登录即跑，此后每 6 小时 | 增量同步本地已登记 Source，并刷新 Inbox | 一份 Receipt |
| `semantic-maintenance` | 每天 10:30 | 从 Inbox 选择最多三个有消费者的主题，维护 Knowledge | 一份 Receipt，`operations[]` 包含各主题处置 |
| `weekly-housekeeping` | 每周一 03:30 | Source 覆盖摘要、缓存与备份清理候选、失败趋势 | 一份 Receipt；不改 Knowledge |
| `report-server` | 常驻，可关闭后随时重建 | 展示 Knowledge、Inbox、Receipt 与健康信息 | 无真相数据，只读投影 |

`source-sync` 固定执行六件事：

1. 初始化并检查 IKB home。
2. 同步 CatPaw Memory 与本地登记文件。
3. 同步 registered targets。
4. 增量导入本地 Agent 会话历史。
5. 根据 Source 变化、zero result 和 feedback 刷新同一个 Inbox。
6. 无论局部成功或失败，写一份最终 Receipt。

它不调用 Agent，不生产或重写 Knowledge，也不为六个内部动作分别创建 Task、Run、Artifact、handoff 或 gate。

`semantic-maintenance` 固定执行六件事：

1. 读取 Inbox，以及每项直接相关的 Source 和现有 Knowledge。
2. 只选择有明确未来消费者的最多三个主题。
3. 对每项作 `new / update / keep / retire`，不另建 Candidate、Experience 或 Analysis 状态链。
4. 客观事实满足权威 Source 与边界条件后可进入 verified；Guide 未经真实任务或人确认保持 draft；Principle 只生成待确认 diff。
5. 把 change、keep 和 ignore 都放进同一份 Receipt；只有 change 才写 Knowledge。
6. 不抓外部系统、不发布、不删除历史、不修改 AGENTS.md。

Source sync 和语义维护互不阻塞：同步失败不应让旧 verified Knowledge 消失，某张旧 Knowledge 校验失败也不应阻止其余 Source 入库。用户调用 `remember`、真实任务产生 feedback 时仍即时写入，不等待定时任务。

## 目录怎样收敛

人工只看到：

```text
ikb-data/
├── knowledge/   # verified 与需要查看的 draft
├── inbox/       # 待整理、待更新、待确认
├── archive/     # retired Knowledge 和历史材料
└── .system/
    ├── sources/
    ├── receipts/
    ├── ledger/
    ├── runs/       # 现有执行兼容，不进入知识主流程
    ├── cache/
    └── backups/
```

产品类型不再决定目录。scope、collection 和标签用于检索；新增业务域不增加顶层文件夹。所有新路径通过一个集中 paths 模块构造，旧绝对路径只由迁移 resolver 读取。

Source、Knowledge、Receipt、人工确认和仍被最终消费者引用的 Result 属于 durable。索引、人物视图、doctor 和 report 属于 cache。2026-08-27 已把 Source、Ledger、Run、Backup 和 Knowledge 迁入目标目录；旧路径通过 relocation 读取。reports、staging 和历史兼容数据因 `deletionReady=false` 保留，不按目录大小删除 Ledger、Source、Run 或备份锚点。

## 现有数据怎样处理

当前 13 张活动 work Knowledge 不批量重写：

| 存量 | 处理 |
|---|---|
| 7 张 Entry | 检查入口是否仍可用；可用就保留，失效才更新 |
| 4 张 Principle | 修复三张正文/状态冲突；其余按人审和投影规则检查 |
| 1 张 Playbook、1 张 Lesson | 按 Guide 的步骤、检查、停止条件做一次真实任务验证 |

150 张归档 Knowledge 继续留在 archive，不作为待恢复队列。已有处置中的 should_not_exist 保持否决记录，recompile_from_source 只有出现真实任务时才回到当前 Source，archive_only 不进入日常维护。

Experience、Candidate、Analysis、QV5、Task/Run 和 Artifact 的现有文件与事件不立即迁移。新主流程不再依赖它们的多状态编排；下一次真实修改命中某个旧对象时，再转成 Source、Inbox 或 Receipt。这样不需要一次性重写历史。

## 这次改造方案

不重写 IKB Core，也不一次性迁移所有历史。按五个可独立验收的批次替换外层合同，旧入口在新入口穿过真实消费者前继续兼容。

| 批次 | 改什么 | 主要改动面 | 完成条件 |
|---|---|---|---|
| 1. 合同归一 | 文档与类型只讲 Source、Knowledge、Inbox、Receipt 和三状态 | `README.md`、`docs/architecture-current.md`、`docs/contracts.md`、架构边界测试 | 文档、类型和默认 HELP 不再把旧过程对象描述成目标架构；现有数据仍可读取 |
| 2. Agent 最小循环 | 在现有能力上增加 `remember / use / feedback` facade | `src/cli.ts`、现有 Source/Knowledge/usage handler、受影响测试 | 一次真实任务能取得 Context、使用 Knowledge、登记 Result 与 feedback；incorrect 退出默认召回并进入 Inbox |
| 3. 收据与写入收敛 | 一次命令或维护只写一份 Receipt；旧 QV5 只读 | 现有 Knowledge repository、revision、usage 与新增最小 Receipt 写入职责 | `operations[]` 可由 Source 和 before/after hash 还原；一次调用不再生成七八份过程文件 |
| 4. 定时任务切换 | 把 20 步 daily 拆成 Source sync 与每日语义维护，精简 weekly | `scripts/ikb-maintenance*.mjs`、三个 launchd plist、`~/.codex/automations/ikb/automation.toml`、maintenance 测试 | 已安装配置与文档频率一致；Source sync 只写一份收据；语义维护最多三个主题；旧路径和旧 QV5 prompt 消失 |
| 5. 原则与存储迁移 | 人审三张冲突 Principle；最后迁移目录并清理无引用历史 | 当前 13 张 Knowledge、AGENTS managed block、layout/storage relocation、`ikb-data` | Principle 正文、状态和投影一致；迁移前后 ID、hash、Source refs 与真实检索结果一致；只删除确认无引用且已有备份的产物 |

实施时遵守三条切换规则：

- 新 facade 没有穿过一次真实 Agent 任务前，不删除旧 internal 命令。
- 新 `source-sync` dry run 与一次正式运行都产出正确摘要后，才卸载旧 20 步 daily；不能让两套写任务并行。
- 目录迁移最后做。先备份、生成引用清单并验证检索，再清理无引用 runs、重复 reports、staging 和过量备份。

明确不做：不批量复活 150 张 archive，不把旧 Experience/Candidate/Analysis 重编译成 Knowledge，不新建工作流状态机，不让定时任务自动确认 Principle，也不把 report/doctor 的历史证据当作知识真相。

## 验收标准

- 主架构只有 Source、Knowledge、Inbox 和 Receipt。
- Agent 需要理解的 Knowledge 状态只有 draft、verified、retired。
- 新知识生产只有保存、对照、处置、确认、写入五步。
- 一次命令或定时运行最多新增一份 Receipt；旧 QV5 只读兼容。
- CLI 公开面只有 remember、use、feedback，其他命令默认隐藏。
- 人不需要执行 CLI；Principle 仍由人确认精确正文。
- Source sync 一次只新增一份 Receipt，不自动生产 Knowledge；每日语义维护最多处理三个主题，也只写一份 Receipt。
- verified Knowledge 能被真实任务召回、使用并记录 feedback。
- incorrect 会退出默认召回并进入 Inbox；retired 不再被普通任务使用。
- 目录迁移和历史清理不损失 Source、Knowledge、确认记录或最终消费者证据。

## 当前实施状态

截至 2026-08-27，本轮已经完成：

- 默认 HELP 只展示 `remember / use / feedback`，旧入口保留为 `--help --all` 可见的 internal compatibility。
- facade 已覆盖 Source 保存、verified Knowledge Context、明确标注的 Source fallback、真实 Result 与 feedback；`incorrect` 会把被使用的 Knowledge 退回 `draft` 并进入 Inbox。
- `.system/receipts` 只有 `ikb-receipt.v1` 单一写入格式；一次 facade 或维护运行最多写一份 Receipt。
- `source-sync`、`semantic-maintenance`、`weekly-housekeeping` 已替代默认旧 20 步入口。已安装 `source-sync` 的 RunAtLoad 运行以退出码 0 结束；每周任务为周一 03:30；报告服务保持只读常驻。
- 真实 Agent 使用任务 `run-3dfef84a-59e` 召回并使用 `kb-principle-risk-evidence`，Result 与 helpful feedback 已入账。
- 语义维护 dry-run 曾选择 3 个 Principle 待确认项并写入 Receipt `receipt-20260827082734078-2678b0ad`。用户随后确认 A、B、C，更新 Receipt 为 `receipt-20260827085537687-5bb517a0`，确认链 Receipt 为 `receipt-20260827090711152-8f116024`。
- 迁移后最终 `pnpm test` 通过 543 项、失败 0 项，耗时约 45.3 秒。

第五批的实施结果：

- 三张冲突 Principle 已完成人工确认、revision 2 更新、lint、默认检索和投影检查，不再是待确认项。
- 已生成可恢复全量备份，迁移 journal 为 `layout-2026-08-27T12-01-48-862Z`。13 张 Knowledge、4296 个 Source、聚合 hash 和五组真实检索在迁移前后一致；Ledger 117630 条事件、0 断链。
- 最新存储审计为 `ikb-data/.system/storage-audits/2026-08-27T12-23-40-099Z.json`：`migrationReady=true`，实时 Run/Artifact 旧路径引用为 0；`deletionReady=false`，所以没有删除 reports、staging、历史 Run 或备份。B 关单后的最终 doctor 为 4303 个 Source、117722 条 Ledger 事件、0 断链，work Knowledge lint 14/14 通过。
- 目录迁移后 source-sync 的 RunAtLoad 退出码为 0，Receipt 为 `receipt-20260827121718461-967ae834`；weekly-housekeeping 已加载，report-server 已在 3417 运行。
- 新候选 `exp-cand-d47a9aa5b0ca` 的唯一待决项 B 已由用户确认，并应用为 `kb-principle-human-confirmation`；状态为 `verified + user_confirmed`，变更 Receipt 为 `receipt-20260827124137734-43056759`。真实消费者只召回该 Principle 并登记 helpful feedback，独立验收结论 pass；单页稿已移到 `ikb-data/archive/inbox/work/confirmations/candidate-batch-e2f6f87a5798.md`，没有自动修改 `AGENTS.md`。
- Experience registry 仍有 8 个历史 `pending_review` Candidate，但均无有效 review package；它们是内部策展积压，不是用户待确认项。只有形成单一、完整、可点击的当前确认稿后，才允许向用户请求确认。
- Codex 每日语义维护已更新为 ACTIVE 的 10:30 配置；下一次宿主运行尚未发生，脚本 dry-run 不能替代这项证据。
