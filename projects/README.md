# IKB 子项目

IKB 是总目录，Core、运行数据和可复用子项目分开管理。

| 子项目 | 职责 | 入口 |
|---|---|---|
| Eval Plane | 统一 Suite、Case、Runner、Adapter、回归 fixture 和真实 Run 评估设计 | `eval-plane/README.md` |
| Agent Team | Codex 原生子 Agent 的委派、边界、Writer/Review Barrier 与行为评测；当前未安装 | `agent-team/README.md` |
| Work Harness（已归档） | Codex/Claude Code 原生子 Agent 编排原型，保留作历史参考 | `_archive/work-harness-20260724/README.md` |

`ikb-data/` 和 `.agent-work/` 是运行数据，不属于子项目源码，也不进入公开版本库。
