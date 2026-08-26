# Agent Team

Agent Team 是 IKB 下的独立实验项目，用来迭代 Codex 原生子 Agent 的委派判断、分支合同、Writer/Review Barrier 和最终验收。2.0.0 已通过静态验证、首轮行为 A/B 和全新任务 canary，当前作为**受控试用插件**安装在默认 Codex。

它不是新的 Agent Runtime。创建、通信、等待和终止继续由 Codex 原生能力负责；本项目只维护可审查的 Skill、Agent、适配器和评测。

## 当前状态

- 2026-08-26 从第三方 `wshobson/agents` 薄 Fork 中抽取。
- 原薄 Fork 已压缩归档到 `/Users/htwu/Archives/agent-team/wshobson-agents-20260826.tar.gz`，只作历史取证，不再作为安装源。
- Codex 候选包物理上只包含 delegate、feature、review 三个 Skill；上游 Claude-first Skill、command 和 agent 不进入候选包。
- 不打包自定义 Agent、不固定子 Agent 模型、不注册 Hook，也不创建全局 Skill 软链接。
- 25 项项目测试、候选包结构校验和 Codex 插件校验已通过。
- 首轮 A/B 证明候选能抑制一个短来源误拆场景；真正并行审计没有性能优势，因此当前定位仍是受控试用。
- 已安装 `agent-teams@ikb-agent-team` 2.0.0；新任务只发现三个入口，单文件 canary 为 0 spawn。

现行设计见 [Agent Team 独立演进方案](docs/evolution-plan.md)；迁移前的问题审计保留在 [历史审计](docs/audit-20260826-pre-migration.md)，只作证据，不再约束当前实现。

## 目录

```text
agent-team/
├── AGENTS.md
├── docs/                         # 当前方案、迁移记录与后续评测
├── plugins/agent-teams/          # Agent Team 唯一源码入口
├── tools/adapters/               # Codex/Pi 生成所需的最小适配代码
├── tools/tests/                  # Codex 与 Pi 合同测试
├── Makefile
└── pyproject.toml
```

`dist/codex-marketplace/` 和 `.pi/` 都是本地生成物，不是真相源。

## 验证

```bash
cd /Users/htwu/projects/_personal/ikb/projects/agent-team
make test
make validate-codex
```

需要单独生成 Pi 实验结果时运行：

```bash
make generate-pi
```

Codex 生成结果位于 `dist/codex-marketplace/`。`make validate-codex` 会先清理旧版遗留的项目级 `.codex/` 发现树，避免源码目录重复加载 Claude-first Skill。生成不等于安装；安装、真实新任务 canary 和回滚状态必须分开报告。

2.0.0 的源码、artifact hash、安装路径和 canary 见 [发布记录](docs/releases/2.0.0.md)。

## 上游与许可证

初始源码来自 `https://github.com/wshobson/agents` 的 `plugins/agent-teams`，许可证为 MIT。迁移后的本地演进继续保留上游作者信息和 [LICENSE](LICENSE)。
