# Eval Plane

Eval Plane 是 IKB 总目录下的独立评估子项目。它维护版本化的 Suite、Case、Result、Report、确定性 Runner、领域 Adapter 和合成回归数据；IKB Core 只通过明确入口调用它。

当前同时支持两种不会混用的评估：

- `regression`：读取固定 fixture，验证规则和 Grader 没有回归；
- `run_assessment`：直接读取真实运行真源。IKB 从 Ledger 装载，Work Harness 从 `.agent-work/<task-id>/` 装载；两者都生成带 `subjectHash` 和 `evaluationKey` 的报告，但不混用状态模型。

IKB 真实 Run 的 L1 检查 Ledger hash chain、Plan 全步骤、Step/Gate/Verifier/Artifact 闭合和事件内容安全。Work Harness 真实 Run 检查任务目录合同、DAG/写范围、节点/Handoff、Verifier、Summary 和重试预算。相同输入的并发评估都会等待并复用同一结果。

## 目录

```text
eval-plane/
├── src/       # Event、兼容 12 Case、契约、Registry、Runner、Run Loader、Coordinator
├── test/      # Eval Plane 自有测试
├── fixtures/  # 不含真实业务数据的合成回归输入
└── docs/      # 评估规范与真实 Run 接入设计
```

## 验证

在本目录运行：

```bash
pnpm test
```

IKB 根目录的 `pnpm check` 也会运行本项目测试。

真实 Run 入口：

```bash
../../bin/ikb run evaluate <run-id> --suite ikb-run-quality --json
../../bin/ikb harness report --suite ikb-run-quality --run <run-id> --json

../../bin/ikb harness eval --suite work-run-quality --task-dir <.agent-work/task-id> --json
../../bin/ikb harness report --suite work-run-quality --task-dir <.agent-work/task-id> --json
```

Work Harness 的 `verify` 会在终态落盘后自动调用同一评估入口。报告位于任务目录的 `evaluations/work-run-quality/`，独立评估事件位于 `evaluations/events.jsonl`；评估结果不会反向改写 Work Harness 的 terminal status。
