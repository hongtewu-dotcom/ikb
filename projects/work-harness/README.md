# Work Harness

Work Harness 是 IKB 总目录下的独立编排子项目。它复用 Codex 或 Claude Code 的原生 Plan 和子 Agent，只负责持久化任务目录、ContextPack、Handoff、DAG、恢复、验收和副作用门禁，不启动另一套 Agent Runtime。

## 目录

```text
work-harness/
├── SKILL.md
├── agents/
├── references/
└── scripts/
```

项目级 Skill 发现路径 `.agents/skills/work-orchestrator` 是指向本目录的兼容链接；源码只维护这一份。

## 验证

```bash
python3 scripts/test_work_harness.py
```

运行产生的 `.agent-work/` 或 `ikb-data/work-harness/` 是任务状态和证据，不属于项目源码。

`verify` 在终态落盘后会自动调用同级 Eval Plane 的 `work-run-quality@v1`。报告写入 `<task-dir>/evaluations/work-run-quality/`；重复或并发触发复用相同 `evaluationKey`。评估质量态不改写 Work Harness 的 terminal status，但 pass verdict 被 L1 质量门阻断时命令返回 3。
