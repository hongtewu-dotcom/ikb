# AGENTS.md

本目录是 IKB 下的 Agent Team 独立子项目。

- 唯一源码入口是 `plugins/agent-teams/`；生成目录不是源码。
- Codex 原生生命周期是唯一执行面，不新增任务队列、在线 DAG、心跳、租约或恢复 Runtime。
- 默认 Codex 已受控安装 `agent-teams@ikb-agent-team` 2.0.0。更新前必须重跑测试、候选校验和新任务 canary；不创建 `~/.codex/skills` 或 `~/.codex/agents` 软链接。
- 原 `wshobson-agents` 只保留为 `/Users/htwu/Archives/agent-team/wshobson-agents-20260826.tar.gz` 压缩归档。不得从归档直接注册、安装或创建软链接；需要历史比对时只解压到临时目录，完成后清理。
- 修改 Skill 的确定性脚本或 adapter 时，先补复现测试，再运行 `make test`；涉及真实调度效果时，静态测试和新任务行为证据分开报告。
- Codex 只从 `plugins/agent-teams/adapters/codex/` 的物理白名单生成候选包；上游 Claude Skill、command 和 agent 不得进入 Codex 包。源码根目录不得保留项目级 `.codex/` 发现树，`make validate-codex` 必须清理历史遗留后只生成 `dist/codex-marketplace/`。
- 不恢复基于读取、spawn、wait、输出体积或压缩次数的硬 Hook。
- 上游源码与本地演进边界写入 `docs/migration.md`，不得抹去 MIT 许可证和原作者信息。
