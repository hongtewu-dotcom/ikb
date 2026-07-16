# ikb

ikb 是个人工作操作系统，不是另一套笔记软件。

它把长期知识、任务执行和 Agent 能力连成一条闭环：记录事实与决策，围绕 Task 组装上下文，调用 Agent 与 Skill 完成工作，验证结果，再把有效经验写回知识库。

当前已进入 v0.1 落地：先交付本地 CLI 和 JSONL 工作账本，知识检索、Harness 和工作流按路线图逐步接入。

## 方案入口

- [产品与架构方案](docs/architecture.md)：系统解决什么问题，知识、执行和控制面如何分工。
- [执行与治理契约](docs/contracts.md)：Agent、Skill、Harness、状态、权限和产物契约。
- [路线图与验收](docs/roadmap.md)：分阶段建设顺序、首批工作流和成功标准。
- [完整落地计划](docs/implementation-plan.md)：CLI 优先的实施拆分、数据落盘、命令设计和阶段验收。

## 当前判断

- Obsidian 作为知识工作台，Markdown 才是知识真相源。
- 真实个人知识与工作知识物理隔离；公开仓只放代码、模板和脱敏示例。
- Task 控制面负责管理工作，Run 负责记录一次执行，知识库不承载运行状态。
- 默认只读和草稿模式；大象发送、CR 评论、push、状态修改等外部动作必须过人工门禁。
- v0.1 先交付本地 CLI，不建设 Web 界面。任务、运行、审批和产物都能通过命令行查询、追踪和导出。
- 知识条目使用 Obsidian 兼容的 Markdown + YAML frontmatter；`related`、`derived_from`、`contradicts` 使用 `[[wikilink]]`，关系变更也进入事件账本。
- 项目对外只使用 ikb 自己的术语：`task / run / approval / artifact / plan`。普通改动使用 Task + 验收条件，高风险改动增加 Plan Pack 和人工批准。

## 本地启动

需要 Node 22.6 或更高版本。当前不依赖外部数据库服务：

```bash
./bin/ikb init
./bin/ikb status
./bin/ikb task add --type document --goal "写一份技术方案" --accept "事实都有来源"
```

工作账本默认落在 `~/.ikb/ledger/events.jsonl`，可以直接打开查看；Run 证据位于 `~/.ikb/runs/`。完整命令见[完整落地计划](docs/implementation-plan.md)。

## Obsidian 知识关系

Obsidian 可以直接打开 `~/.ikb/vaults/personal` 或 `~/.ikb/vaults/work`。ikb 为每条知识写入稳定 ID 和 alias，关系字段保持为可点击的 `[[knowledge-id]]`；`related` 和 `contradicts` 自动双向维护，`derived_from` 保持从新知识指向依据的单向关系。

```bash
./bin/ikb knowledge relate <from-id> <to-id> --type related
./bin/ikb knowledge relate <from-id> <to-id> --type derived_from
./bin/ikb knowledge relate <from-id> <to-id> --type contradicts
```

个人与工作 Vault 默认不能互相建立链接；确实需要跨域时显式加 `--allow-cross-scope`。关系命令是幂等的，重复执行不会产生重复链接；有实际变更才写入 `knowledge.related` 事件。
