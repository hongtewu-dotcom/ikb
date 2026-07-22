# IKB 子项目

IKB 是总目录，Core、运行数据和可复用子项目分开管理。

| 子项目 | 职责 | 入口 |
|---|---|---|
| Eval Plane | 统一 Suite、Case、Runner、Adapter、回归 fixture 和真实 Run 评估设计 | `eval-plane/README.md` |
| Work Harness | Codex/Claude Code 原生子 Agent 的任务拆分、ContextPack、Handoff、恢复和验收 | `work-harness/README.md` |

`ikb-data/` 和 `.agent-work/` 是运行数据，不属于子项目源码，也不进入公开版本库。
