# 统一 Harness Eval Plane

IKB 的 Ledger、Source、Artifact 和 Knowledge 仍是真相源；Eval Plane 只是把确定性评估契约、回放、适配和本地报告统一起来。评估器直接读取本地事件和 Artifact 引用，不依赖外部观测服务。

## 评估边界

评估不压成一个总分：

- **L1 协议与安全**：Plan/DAG、节点合同、Handoff、状态、证据引用、Verifier/Artifact/Gate、scope、Approval、幂等和副作用隔离。L1 失败即硬门禁失败。
- **L2 通用执行能力**：首次/最终通过、重试和恢复、修复轮次、人工介入、并行利用率、冲突率等，作为报告指标。
- **L3 领域结果**：IKB 准入、Work Harness 任务、SpecX AC、测试流水线断言和清理等，按 Adapter 输出领域指标。

第一阶段只运行确定性 Grader。LLM Judge 只作为契约中的扩展类型，不能改变硬门禁。

## 契约和版本

代码位于 `projects/eval-plane/src/`，fixture 和测试也随子项目放置：

- `eval-contract.ts`：`EvalSuite`、`EvalCase`、`EvalResult`、`EvalReport` 的 schema/version、引用安全和字段校验；禁止 Prompt、模型输出、原始路径、URL、Approval payload 进入评估结果。
- `eval-registry.ts`：按 `suite_id@suite_version` 注册，重复版本拒绝；每套 Suite 明确标记为 `regression` 或 `run_assessment`。
- `eval-runner.ts`：fixture/replay 与真实 RunSubject 的确定性执行、L1 硬门禁、按 Case 的 before/after 比较。
- `eval-adapters.ts`：`ikb`、`work-harness`、`specx`、`pipeline` 四个 Adapter；阈值由 Suite 配置传入。
- `run-subject.ts`：从 Ledger 读取 Run、Task、事件、Artifact、Approval 和 Plan；先把 Ledger hash-chain 完整性纳入输入，过滤既有评估输出后生成稳定 `subjectHash`。
- `run-assessment.ts`：`ikb-run-quality` 的 8 个真实 Run Case。
- `evaluation-coordinator.ts`：处理 `evaluationKey`、报告持久化、Artifact 注册、事件写回、幂等复用和补偿扫描。
- `work-run-subject.ts`：直接读取 Work Harness task-dir，不转换成 IKB Ledger；评估输出事件不参与 `subjectHash`。
- `work-run-assessment.ts`：`work-run-quality` 的 7 个真实 Run Case，覆盖合同、DAG/范围、Handoff、Verifier、重试、恢复和领域边界。
- `work-evaluation-coordinator.ts`：把报告和独立评估事件原子写回 task-dir，并负责并发幂等和篡改检测。

IKB 原有 `harness-eval.v1` 和 12 个 Case 保留不变；Registry 将其拆为：

1. `ikb-admission-knowledge`
2. `ikb-mid-run-quality`
3. `ikb-approval-recovery-security`
4. `ikb-outer-loop`

## CLI

```bash
# 查看全部 Suite、版本、层级和 Case
./bin/ikb harness suite list --json

# 兼容的旧 12 Case
./bin/ikb harness eval --json
./bin/ikb harness eval --case M2-terminal-success-is-not-quality --json

# Regression Suite 只读固定 fixture，不允许挂到真实 Run
./bin/ikb harness eval --suite work-protocol --json

# Run Assessment 直接读取真实 Ledger；run finish/succeed/fail/cancel 后也会有界触发
./bin/ikb run evaluate <run-id> --suite ikb-run-quality --json
./bin/ikb harness eval --suite ikb-run-quality --run <run-id> --json
./bin/ikb harness report --suite ikb-run-quality --run <run-id> --json

# Work Run Assessment 直接读取 task-dir；Work Harness verify 后会自动触发
./bin/ikb harness eval --suite work-run-quality --task-dir <.agent-work/task-id> --json
./bin/ikb harness report --suite work-run-quality --task-dir <.agent-work/task-id> --json

# 补评历史终态 Run；日常维护也会运行同一补偿入口
./bin/ikb harness repair --suite ikb-run-quality --limit 100 --json

# 生成 Regression 报告，或比较同一 Suite 的两个结果 Artifact
./bin/ikb harness report --suite work-protocol --json
./bin/ikb harness report --suite work-protocol --before <before.json> --after <after.json> --json
```

真实 Run 的完整 `EvalReport` 写到 `ikb-data/evaluations/<suite>/`，并通过 `LedgerStore.createArtifact` 登记为 `evaluation_report`。`run.evaluation_completed` 只保存 Suite/版本、`subjectHash`、`evaluationKey`、状态、计数、Case reason code、恢复指标和 Artifact 引用。相同输入重复执行直接复用既有报告，不新增 Artifact 或事件；并发的相同 `evaluationKey` 会有界等待首个执行者完成，再 reload Ledger 并复用结果。

`ikb-run-quality` 当前覆盖 Ledger 完整性、质量证据链、terminal/quality 分离、Handoff、DAG、Approval 绑定、副作用幂等、恢复质量和领域 Adapter 边界。L1 要求 Plan 中每个 Step 成功闭合，并要求每个已登记产物同时被成功 Step、通过 Gate、Verifier artifactRefs 和 Verifier check evidence 覆盖。L3 在尚未注册领域 Adapter 时明确返回 `not_applicable`，不会用通用规则伪造业务正确性。

`work-run-quality` 不依赖 IKB Artifact Ledger。它读取 `task.json`、`plan.json`、`run-state.json`、`events.jsonl`、`nodes/*/handoff.json`、`run-summary.json` 和 `verification.json`；报告落在 `<task-dir>/evaluations/work-run-quality/`。Work Harness 的 terminal status 与评估质量态分开保存：`verify --verdict pass` 已经完成终态落盘，但若 L1 评估阻断，命令会返回非零，报告保留真实 reason code，状态不会被伪装成 failed。

## 改进闭环

同一 Suite 的 before/after 比较只输出 Case 状态、reason code 和变化列表，不自动修改 Prompt、Skill、角色、权限或门禁。重复失败仍由 IKB Outer Loop 聚类，形成 `pending_review` 候选，经过人工/独立 Verifier 和同一回归集验证后，才能更新规则或 Knowledge。

`projects/eval-plane/fixtures/` 下的 Work Harness、SpecX 和 pipeline 文件仍是合成回归输入，不含公司数据。`work-protocol` 用它们回归 Grader；`work-run-quality` 读取本机真实 task-dir。真实正文不会写入 Suite 或公共 fixture。
