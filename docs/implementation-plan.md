# ikb 完整落地计划

## 结论

v0.1 不依赖第三方任务平台，也不建设 Web 界面。先交付一个本地 CLI 控制面和不可变工作账本，再接知识检索、Agent/Skill Harness 和具体工作流。

第一阶段必须做到四件事：

1. 每项工作有 Task，目标、验收和当前状态可查。
2. 每次执行有 Run，输入、上下文、步骤、失败和产物可追。
3. 每个高风险动作有 Approval，批准了什么、谁批准、实际执行了什么可核对。
4. 进程退出或机器重启后，状态能恢复，历史不会被新一次执行覆盖。

界面只是一种读取方式。CLI、未来的 TUI 和 Web 都消费同一应用服务、事件账本和查询模型。

## v0.1 的交付边界

v0.1 完成“写技术方案”这一条纵向闭环：

```text
创建 Task
  → 检查目标与验收
  → 检索个人/工作知识
  → 生成 context pack
  → Document Agent 产出草稿
  → 事实与来源检查
  → 用户接受或修改
  → 保存 Artifact 与差异
  → 生成候选知识
  → Task 完成
```

v0.1 不做：浏览器看板、移动端、多人协作、通用向量平台、自动发送大象消息、自动提交 CR 评论、自动 push、生产变更和支付类动作。

## 统一术语

| 对象 | 含义 | CLI 入口 |
|---|---|---|
| Knowledge | 未来仍会影响判断的事实、决策、偏好和方法 | `ikb knowledge` |
| Task | 一项要完成的工作，包含目标和验收 | `ikb task` |
| Run | 对同一 Task 的一次执行尝试 | `ikb run` |
| Approval | 对一个明确副作用或风险决定的人工批准 | `ikb approval` |
| Artifact | 草稿、报告、diff、测试结果等运行产物 | `ikb artifact` |
| Agent | 负责语义判断和任务产出的角色 | `ikb agent` |
| Skill | 有明确输入、输出和副作用的原子能力 | `ikb skill` |
| Plan Pack | 高影响改动的轻量方案附件 | `ikb plan` |

仓库、目录、命令和文档只使用 ikb 自己的名称，不引入另一套项目状态或外部框架命名。

## 技术基线

- 语言与工程：Node LTS、TypeScript、pnpm workspace。
- 契约：TypeScript 类型 + 运行时 schema 校验，事件格式版本化。
- 工作账本：`events.jsonl`。文件追加、哈希链和账本锁保证不可变事件；Task/Run/Approval 等状态由事件重放得到。
- 知识真相源：Markdown + Git。FTS、Embedding 和关系索引都是可删除的派生数据；SQLite 只有在查询规模和并发确实需要时才作为索引层引入。
- 运行证据：每个 Run 一个独立目录，关闭后只追加补充记录，不覆盖原始输入和事件。
- 测试：单元测试、契约测试、迁移测试、崩溃恢复测试和纵向 E2E。
- 界面：先普通 CLI；命令稳定后再增加 TUI；Web 最后建设。

先用 FTS5、字段过滤和链接关系完成检索。只有真实任务证明召回不足时才增加 Embedding，不在冷启动阶段建设向量基础设施。

## 数据落盘

```text
~/.ikb/
  config.yaml                    # Vault、运行时和安全策略配置
  ledger/
    events.jsonl                 # 不可变事件真相源
    events.lock                  # 多进程写入锁
  backups/                       # events.jsonl 与配置备份
  runs/
    <run-id>/
      input.json                 # Task 与参数快照
      context-pack.md            # 实际交给 Agent 的上下文
      plan.json                  # 本次执行步骤
      events.jsonl               # 本次运行事件副本
      checkpoint.json            # 恢复点
      artifacts/                 # 草稿、报告、diff、测试等
      verification.json          # 确定性检查与人工决定
      run-digest.md              # 面向复盘的短摘要
  reports/                       # 派生的日报、周报和审计导出

~/Knowledge/personal-vault/      # 个人知识，私有 Git 或本地备份
~/Knowledge/work-vault/          # 工作知识，公司允许的存储位置
```

公开的 `ikb` 仓库只放代码、schema、模板、测试夹具和脱敏示例。真实 Task、Run 和知识不提交到公开仓库。

## 工作账本设计

### 不可变事件

所有写操作统一为“校验命令 → 获取账本锁 → 追加 JSONL 事件 → 释放锁”。读取方按文件顺序重放事件得到当前状态，不维护第二套运行状态真相。首批事件包括：

```text
task.created
task.updated
task.started
task.waiting
task.done
task.canceled
run.queued
run.started
run.step_started
run.step_finished
run.checkpointed
run.awaiting_approval
run.failed
run.finished
approval.requested
approval.approved
approval.rejected
action.executed
artifact.created
knowledge.referenced
knowledge.candidate_created
```

每个事件保存对象内序号、操作者、时间、因果事件、关联 Task/Run、payload hash 和变更摘要。历史事件不能 update 或 delete；修正错误要追加补偿事件。

### 状态投影

首版不持久化运行状态投影，CLI 启动时从 `events.jsonl` 重放。需要索引时再增加可删除的派生目录；它不能阻塞账本写入，也不能成为恢复依据。

状态投影至少包含：Task 当前状态、Run 状态与 checkpoint、Approval 决定、Artifact 路径与 hash、Task/Run 的知识引用和待执行外部动作。

`ikb ledger rebuild` 重新读取事件并输出投影摘要；`ikb doctor` 校验 JSONL 语法、payload hash、事件 hash 链和 Run 目录。任何异常都必须报错，不能静默修复。

### Approval 绑定

Approval 不是“同意这个 Agent 随便做”。它绑定准确的动作类型、目标、参数 hash、风险说明和有效期。参数发生变化后旧 Approval 自动失效；Action Gateway 执行完成后追加 `action.executed`，保存外部对象 ID 和幂等键。

## 首批 CLI

### 总览与检查

```text
ikb init
ikb status
ikb show <task-or-run-id>
ikb timeline <task-or-run-id>
ikb doctor
ikb backup
ikb restore <backup-dir> --yes
```

`ikb status` 默认只显示需要注意的内容：active/waiting Task、running/failed Run、pending Approval、待复核知识和最近异常。

### Task

```text
ikb task add --type document --goal "..." --accept "..."
ikb task list [--status active] [--type coding]
ikb task show <task-id>
ikb task update <task-id>
ikb task start <task-id>
ikb task wait <task-id> --reason "..."
ikb task done <task-id> --evidence <artifact-id>
ikb task cancel <task-id> --reason "..."
```

### Run、Approval 与 Artifact

```text
ikb run start <task-id> --agent document
ikb run list [--status failed]
ikb run show <run-id>
ikb run follow <run-id>
ikb run resume <run-id>
ikb run retry <run-id> [--agent <agent-id>]
ikb run cancel <run-id>

ikb approval list
ikb approval show <approval-id>
ikb approval approve <approval-id> --note "..."
ikb approval reject <approval-id> --reason "..."

ikb artifact list <run-id>
ikb artifact open <artifact-id>
ikb artifact show <artifact-id>
```

### Knowledge 与报表

```text
ikb capture <source-file|text> --title "..."
ikb ingest <markdown-file> [--scope work]
ikb search "..." [--scope work]
ikb context <task-id> [--run <run-id>]
ikb knowledge list|show|verify|retire|review
ikb knowledge relate <from-id> <to-id> --type related|derived_from|contradicts [--allow-cross-scope]
ikb report daily [--format md|json]
ikb report weekly [--format md|json]
```

所有查询命令支持 `--output table|json`，方便人查看，也方便 Agent 和脚本消费。

## 分阶段实施

阶段以验收门槛推进，不按日期强行切换。下面的时间是单人集中开发的粗估，不包含真实工作流观察期。

### P0：冻结 v0.1 基线，1 天

交付：架构、契约、路线图、完整落地计划和术语表。

退出条件：文档中不存在第二套项目命名；Task、Run、Approval、Artifact、Knowledge 的边界一致；外部副作用都有明确策略。

### P1：工程骨架，1～2 天

交付：pnpm workspace、CLI 入口、配置加载、运行时 schema、事件格式版本、测试框架、脱敏 demo Vault 和 CI。

退出条件：全新目录执行 `ikb init` 后能生成配置与数据目录；重复执行不破坏已有数据；`ikb doctor` 能报告基础环境状态。

### P2：本地工作账本，3～5 天

交付：JSONL 事件账本、Task/Run/Approval/Artifact 重放投影、运行目录、timeline、status、report、backup 和 ledger verify/rebuild。

退出条件：

- 能创建 Task，手工推进一次 Run，挂接 Artifact 并完成验收。
- 任一 Task 的全部状态变化都能从 timeline 看到。
- 杀掉进程后重启，Task/Run 状态和 checkpoint 不丢。
- 删除投影后能从事件重建相同状态。
- 从 P3 开始，ikb 后续开发任务全部用本地账本管理。

### P3：知识底座，5～8 天

交付：Markdown schema、source registry、capture/ingest、draft/verified/retired、冲突与过期检查、FTS5、统一 search、context pack、引用追踪和 Vault doctor。

退出条件：

- 从脱敏文档生成 draft，来源与内容 hash 可追溯。
- verified 知识没有来源时无法写入。
- personal/work scope 在检索和导出时不会串用。
- 删除全文索引后可以从 Markdown 完整重建。
- Agent 输出能声明实际使用了哪些知识、支持了哪个判断。

不做全量搬家。现有 Memory、Obsidian 和文档只按真实任务需要逐步摄入，先形成高价值 verified 知识。

### P4：Harness 运行时，5～8 天

交付：Agent/Skill manifest、runtime adapter、固定步骤状态机、context builder、质量检查、重试、checkpoint、前台 runner、本地 daemon 和 Action Gateway。

退出条件：

- 同一个 Task 可以有多个 Run，失败历史不会被覆盖。
- Run 能从最近 checkpoint 恢复，不重复执行已确认的副作用。
- 未在 manifest 声明的 Skill 无法调用。
- L3 动作必须生成 Approval；payload 变化后旧批准失效。
- Agent 更换模型或 runtime 后，输入输出契约保持不变。

### P5：技术方案纵向切片，3～5 天

交付：Document Agent、写作 Skill 适配、事实/来源检查、草稿 diff、人工接受/修改记录和知识候选回写。

退出条件：使用真实但可脱敏的技术方案连续跑通 10 次；每次都能解释引用了什么知识、产生了什么修改、为什么完成；不需要直接翻原始事件文件或运行目录才能定位失败。

随后进入两周 shadow 使用期，记录草稿接受率、人工修改幅度、缺失知识和错误引用。数据不达标时先修知识与契约，不急着增加工作流。

### P6：编码、评审与 CR，1～2 周

交付：Git/worktree、GitNexus、构建测试、diff 报告、行级审查证据，以及 Coding/Review/CR Agent。

退出条件：

- 编码 Run 在隔离 worktree 中执行，测试和 diff 是 Artifact。
- Review/CR 结论包含文件、行号、证据和优先级。
- push 与外部评论停在 Approval，不能由 prompt 绕过。
- 失败 Run 可以保留现场并从 checkpoint 重试。

### P7：沟通、向上管理和外部连接器，逐个接入

先做只生成草稿，再逐个增加学城、ONES、大象、日历等连接器。每个连接器独立交付，不打包开放权限。

退出条件：凭证不写入知识或日志；外部写入有幂等键、Approval、结果回读和失败重试；同一个动作不会重复发送。

### P8：TUI、Web 与远程查看，CLI 稳定后再做

先增加 `ikb tui`，提供 Today、Tasks、Runs、Approvals 和 Knowledge 五个终端视图。确认高频信息结构后再建设 Web。

退出条件：CLI、TUI、Web 对同一对象显示一致；任何写操作生成相同事件；界面层可以删除重建，不影响核心数据和执行。

### P9：OUTER LOOP，真实数据积累后再做

交付：周度运行摘要、失败聚类、知识缺口、Skill 成功率、决策预测验证和候选补丁队列。

退出条件：每个改进建议能追溯到真实 Run；高影响补丁进入 Plan Pack 和 Approval；相同失败再次发生时能命中已验证修法；无效果规则可以被撤回。

## 质量与恢复门槛

每个里程碑至少包含以下验证：

| 类别 | 必须证明的内容 |
|---|---|
| Contract | 非法状态转换、缺少来源、越权 Skill 和无效 Approval 被拒绝 |
| Persistence | 老版本事件格式能被读取，未知字段不会被静默丢弃 |
| Recovery | 进程中断、步骤超时、重复命令和外部写入回包丢失后可恢复 |
| Audit | Task 当前状态能关联到事件、Run、Artifact 和人工决定 |
| Security | scope 隔离、日志脱敏、凭证引用和 Action Gateway 不能绕过 |
| E2E | 至少一条真实纵向工作流从 Task 创建跑到知识回写 |

事件格式变更必须带版本、旧夹具和回滚说明。状态机、权限、恢复语义和稳定数据契约发生变化时，创建 C 级 Plan Pack；普通文档和局部实现不增加额外流程负担。

## v0.1 完成定义

满足下面全部条件，才算完成，不以“代码已经写了”作为结束：

- `ikb status` 能在一分钟内说明现在做什么、卡在哪里、需要谁处理。
- 任意 Task 可以查看完整 timeline，任意 Run 可以查看输入、context、步骤、日志、产物和验证。
- 机器重启后可以恢复未完成 Run；失败重试不会覆盖历史。
- 知识引用有来源、有 scope，错误或过期知识不会静默进入 verified。
- 技术方案工作流在真实使用中连续跑通，并留下人工修改差异。
- 所有外部写入默认关闭；批准与实际执行参数可以逐项核对。
- 备份、恢复、账本重建和索引重建均经过自动化验证。

这时再决定是先扩编码/CR，还是先做 TUI。决定依据是两周真实使用数据，不靠预设偏好。
