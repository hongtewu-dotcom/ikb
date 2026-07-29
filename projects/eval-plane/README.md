# Eval Plane

Eval Plane 是 IKB 总目录下的独立评估子项目。它维护版本化的 Suite、Case、Result、Report、确定性 Runner、领域 Adapter 和合成回归数据；IKB Core 只通过明确入口调用它。

当前同时支持两种不会混用的评估：

- `regression`：读取固定 fixture，验证规则和 Grader 没有回归；
- `run_assessment`：直接读取真实运行真源。IKB 从 Ledger 装载，Work Harness 从 `.agent-work/<task-id>/` 装载；两者都生成带 `subjectHash` 和 `evaluationKey` 的报告，但不混用状态模型。

IKB 真实 Run 的 L1 检查 Ledger hash chain、Plan 全步骤、Step/Gate/Verifier/Artifact 闭合和事件内容安全。Work Harness 真实 Run 检查任务目录合同、DAG/写范围、节点/Handoff、Verifier、Summary 和重试预算；L2 从主 `events.jsonl` 的 `task.verified → evaluation.trigger_completed|failed|skipped` 序列识别跨轮恢复，节点 `retryRounds` 单独统计。相同输入的并发评估都会等待并复用同一结果。

Work Harness 可在 task-dir 注册 `domain-evaluation.json`。该文件使用 `work-harness-domain-evaluation-v1` snake_case 合同，绑定 task/run、领域 Suite/Grader、required、领域结果、报告文件 SHA-256、标量 metrics 和 evidence。报告必须是普通非 symlink 文件；相对 `file://` 引用基于 task-dir，绝对路径也允许。未注册时 L3 为 `not_applicable`，注册通过时评真实 `pass`，required 失败会令整份报告 `hardGatePassed=false`。

`task.scope`、节点 `read_scope` 和 `write_scope` 的每个数组元素只能表达一个 scope。逗号拼接多个 scope、或一个元素内放入多个绝对路径时，Subject 仍可读取，但 L1 integrity 会用字段级稳定 reason code 阻断。

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

当前评估合同是 `work-run-quality@v4` + `work-harness-run-subject.v4`。v4 在 v3 基础上绑定 evaluator 的 `verification_id`、把质量终态 trigger 语义纳入缓存键、关闭 stale recovery 写区间，并严格校验 managed Handoff 身份、数组元素和 UNC scope；历史 v1/v2/v3 报告和事件索引保留审计，但不得被 v4 复用。managed/legacy 判定联合读取 run-state、`nodes/<id>/execution.json` 和主事件中的 `node.started|node.handoff_recorded.execution_id`：任一来源带强身份时都禁止因 run-state 单字段缺失降级，五字段冲突产生稳定 reason code，并同时阻断 L1 与 closure；只有三类来源都没有 ID 才走 legacy。

`subjectHash` 与 L2 共用一套单遍 attempt 状态机：每个 `task.verified` 建立 pending attempt，带 `verification_id` 的 terminal trigger 只在到达时消费对应 pending 队列。early/unmatched trigger 和 attempt 已消费后的重复或冲突终态既不影响 L2，也不进入 hash；匹配项按 verification attempt 顺序稳定排列，因此 T2,T1 与 T1,T2 得到同一 key，但两个真实 attempt 即使摘要相同也会各保留一项。legacy 无 id trigger 继续按 FIFO 匹配，并在事件语义时间线中保留物理阶段。摘要只保留 event、verification identity、result、hard gate 和 reason 等语义，排除时间、evaluationKey、reportRef、reused 与 `verification.json.evaluation_triggers` bookkeeping；晚到且成功匹配的 trigger 只推进一次缓存代际，随后稳定复用。

Work Harness 可用 `work-eval-cli --verification-id <id>` 绑定本次 verify。提供该参数时，每次 Subject 初载和锁内 reload 都必须同时匹配 `verification.json.verification_id` 与最新 `task.verified.verification_id`，输出回传 verificationId、subjectHash、subjectVersion 和 suiteVersion；不提供参数的直接 IKB 评估保持兼容。

Coordinator 在缓存命中和新评估提交前都会再次读取 bound Subject，并同时核对 verification identity、`subjectHash` 与 `evaluationKey`；变化时放弃本轮并最多重试三次。新评估只有在最终检查通过后才追加完成事件，本轮刚创建但已失去绑定的报告会在 hash 对账后删除；没有完成事件的既有孤立文件不参与缓存。最终检查是提交线性化点：evaluation-key 锁保证同 key 只有一个发布者，Work Harness 调用方的 task lock 则覆盖 stdout 消费和 trigger 落盘；绕过合同的直接文件覆盖若发生在该点之后，属于下一快照并由下一次评估生成新 key。

新写入的 `evaluation.completed` 显式携带 `hardGatePassed`，且 reader 会把它与 `result` 及报告重算结果逐值对账。历史同 schema 事件若缺该字段，仍按 `blocked=false`、`pass|partial=true` 映射后读取；一旦字段存在但自相矛盾则拒绝，不再把新生产者漏字段混同为历史兼容。
