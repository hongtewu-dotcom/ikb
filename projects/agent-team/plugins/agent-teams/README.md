# Agent Teams

这是 Agent Team 的唯一源码目录。Codex 版本是一层薄治理，只决定什么时候值得使用原生子 Agent、怎样限定写域和审查快照，以及主 Agent 如何汇合和验收。

## Codex 发布边界

Codex 只从以下目录构建：

```text
adapters/codex/plugin.json
adapters/codex/skills/
├── agent-team-delegate/
├── agent-team-feature/
└── agent-team-review/
```

构建结果位于 `dist/codex-marketplace/`。候选包物理上只包含三个 Skill，不包含自定义 Agent、命令、Hook、MCP 或第二套 Runtime，也不会暴露本目录原有的 Claude-first `skills/`、`commands/` 和 `agents/`。

三个入口分别负责：

- `agent-team-delegate`：独立性与收益判断、最小分支合同、原生生命周期和结果验收。
- `agent-team-feature`：共享契约冻结、互斥写域、Writer Barrier 和主线程集成。
- `agent-team-review`：同一冻结快照、只读审查、reader-repair barrier 和最终 verifier。

普通子 Agent 不固定模型和 reasoning effort，继承当前宿主配置。独立分支使用 `fork_turns: "none"`，只接收完整 Task Request；低成本模型路由留作独立实验。

## 构建与验证

```bash
cd /Users/htwu/projects/ikb/projects/agent-team
make test
make validate-codex
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  dist/codex-marketplace/plugins/agent-teams
```

`make validate-codex` 会先清理旧候选包，再从白名单源码重建。生成和测试不会注册 marketplace，也不会修改 `~/.codex`。

正式安装先把已校验候选复制为带版本和 hash 的只读快照，再注册该快照。2.0.0 当前入口是：

```bash
codex plugin marketplace add \
  /Users/htwu/.local/share/codex-marketplaces/ikb-agent-team/2.0.0-b3b5e673 --json
codex plugin add agent-teams@ikb-agent-team --json
```

安装后必须用全新持久任务验收。当前 Codex CLI 的原生 spawn 依赖已登记 thread，`codex exec --ephemeral` 不用于多 Agent canary。

## 其他宿主

原上游 Claude 命令、Agent 和策略 Skill 保留用于来源追踪，不进入 Codex 候选包。Pi 实验位于 [`adapters/pi/`](adapters/pi/README.md)，它有独立运行时和验收，不用于证明 Codex 需要 Dynamic Workflow。

上游来源与许可证边界见 [迁移记录](../../docs/migration.md)。真实行为证据见 [Codex A/B](../../docs/evals/2026-08-26-codex-ab.md)。
