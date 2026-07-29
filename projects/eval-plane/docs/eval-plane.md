# 统一 Harness Eval Plane

IKB 的 Ledger、Source、Artifact 和 Knowledge 仍是真相源；Eval Plane 只是把确定性评估契约、回放、适配和本地报告统一起来。评估器直接读取本地事件和 Artifact 引用，不依赖外部观测服务。

## 评估边界

评估不压成一个总分：

- **L1 协议与安全**：Plan/DAG、节点合同、Handoff、状态、证据引用、Verifier/Artifact/Gate、scope、Approval、幂等和副作用隔离。L1 失败即硬门禁失败。
- **L2 通用执行能力**：首次/最终通过、重试和恢复、修复轮次、人工介入、并行利用率、冲突率等，作为报告指标。
- **L3 领域结果**：IKB 准入、Work Harness 任务、SpecX AC、测试流水线断言和清理等，按 Adapter 输出领域指标。Work Harness 的领域投影声明 `required=true` 时，L3 失败也进入硬门禁。

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
- `work-run-subject.ts`：直接读取 Work Harness task-dir，不转换成 IKB Ledger；只把与真实 verification attempt 匹配的质量终态语义纳入 `subjectHash`，其余评估 bookkeeping 排除。
- `work-execution-identity.ts`：联合 run-state、execution descriptor 与已投影主事件判定 managed identity，禁止单字段降级并输出字段级 reason code。
- `work-quality-history.ts`：为 L2 与 `subjectHash` 提供同一套 `task.verified → evaluation.trigger_*` pending-attempt 单遍匹配状态机。
- `work-domain-evaluation.ts`：校验 `domain-evaluation.json` 的身份、字段安全、报告文件类型和原始字节 SHA-256。
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

`work-run-quality` 不依赖 IKB Artifact Ledger。当前合同为 `work-run-quality@v4` 和 `work-harness-run-subject.v4`，它读取 `task.json`、`plan.json`、`run-state.json`、`events.jsonl`、`nodes/*/handoff.json`、`run-summary.json`、`verification.json`，以及可选的 `domain-evaluation.json`；报告落在 `<task-dir>/evaluations/work-run-quality/`。Work Harness 的 terminal status 与评估质量态分开保存：`verify --verdict pass` 已经完成终态落盘，但若 L1 或 required L3 评估阻断，命令会返回非零，报告保留真实 reason code，状态不会被伪装成 failed。

v4 是 verification identity、terminal trigger 缓存语义、stale recovery 区间、managed Handoff 和 UNC scope 完整性的显式缓存边界。`evaluationKey` 同时包含 Suite 版本和含 subject 版本的 `subjectHash`，因此历史 v1/v2/v3 报告及 `evaluations/events.jsonl` 索引仍可留作审计，但新评估必须生成不同的 v4 key，不能返回 `reused=true`。

Scope 数组按元素校验，坏值保留在 Subject 中供审计，不在 Loader 边界抛错。`native-plan-step` 可按受支持的 import 形状省略 `read_scope`/`write_scope`，此时投影为 `[]`；字段一旦存在仍走完整校验。单个元素含逗号时分别记录 `task_scope_comma_joined`、`node_read_scope_comma_joined` 或 `node_write_scope_comma_joined`；单个元素出现两个以上 Unix、Windows drive 或 UNC 绝对路径时分别记录 `task_scope_multiple_absolute_paths`、`node_read_scope_multiple_absolute_paths` 或 `node_write_scope_multiple_absolute_paths`。这些 reason code 进入 L1 integrity，使旧任务保持可读取，但不能继续得到合法质量结论。

并发写范围比较先做与 Harness 等价的 lexical canonicalization：统一重复分隔符和点段，识别相对根、POSIX 根、Windows drive/UNC 根，并按 Windows 大小写语义比较路径段。根 scope 覆盖其全部后代，不同 Windows drive 不冲突；该规范化只用于冲突判断，不会改写原 scope 或改变旧坏 scope 的稳定 reason code。

`node.stale_recovered` 与 `node.handoff_recorded` 一样关闭旧 execution 的 active 写区间，后续 retry 的 `node.started` 不会与自身旧 attempt 形成假冲突。managed 判定联合 `run-state.executions.<node>`、`nodes/<node>/execution.json` 与一次解析得到的 `node.started|node.handoff_recorded` 事件：任一来源存在 `execution_id` 就必须把 task_id、run_id、node_id、attempt、execution_id 与当前 Handoff 精确对账；run-state 删除 ID、descriptor/event 冲突或 stale Handoff 都产生字段级稳定 reason code，并同时阻断 L1 与 closure。三类 managed 证据都没有 ID 时才走显式 legacy 兼容。Handoff 的 evidence、artifacts、validation、risks 都只接受非空字符串元素，混入对象、null、数字或空白字符串同样阻断 L1。

### Work Harness 跨轮恢复

L2 单遍扫描事件：每个 `task.verified` 建立一个 pending attempt，带 `verification_id`、同 run/Suite 的 `evaluation.trigger_completed|failed|skipped` 只在到达时消费对应 pending 队列；多个并发 pending verification 不互相覆盖，trigger 回写乱序也按身份归位。early/unmatched trigger 和 attempt 已消费后的重复或冲突终态被忽略，冲突终态保持 first-wins；重复同一 id 的多个 verification 仍按该 id 队列逐个消费。历史双方都没有 id 时按 verification 追加顺序与 trigger 追加顺序做确定性 FIFO 配对。

每次 attempt 通过都要求 verification verdict 为 pass；已完成 attempt 还要求 trigger 为 completed、`hard_gate_passed=true`、`result=pass`，pending attempt 则要求当前 L1/common closure 和当前整体结果均为 pass。required blocked 和 optional blocked/partial 都令当前 `finalPass=false`。`repairRounds` 只统计未通过的质量 attempt；节点 attempts 单独形成 `retryRounds`，不影响 `firstPass`，也不会把 retry-only 误报为 recovery。

主 `events.jsonl` 中的 `evaluation.trigger_*` 会进入内存 Subject，供 L2 读取。生成 `subjectHash` 时，v4 复用同一单遍状态机，只投影被真实 attempt 消费的 `work-run-quality` terminal trigger：event、verification_id、run/Suite identity、result、hard_gate_passed 和 reason 参与 hash，时间、evaluationKey、reportRef、reused 等 bookkeeping 不参与；其他 `evaluation.*` 仍排除。带 id 的匹配项按 verification attempt 顺序排列，因此 T2,T1 与 T1,T2 不会仅因回调顺序产生不同 key；不做全局摘要去重，两个真实 attempt 的相同摘要仍各占一项。early/unmatched 和消费后的重复终态不入 hash；legacy 无 id trigger 按 FIFO 匹配并保留在原语义时间线中的物理阶段。verification 语义 hash 同样排除 `evaluation_triggers` bookkeeping。晚到且成功匹配的 terminal trigger 会生成一次新 key，使 cached 结果与相同最终事件的新鲜计算一致；该语义稳定后再次执行才返回 `reused=true`。

`work-eval-cli` 接受可选 `--verification-id`。提供时，Coordinator 在初次读取和每次 evaluation-lock 内 reload 后，都要求 `verification.json.verification_id` 与最新 `task.verified.verification_id` 同时等于期望 id；不一致立即失败，不能让延迟的 V1 evaluator 读取并接受 V2。成功输出回传 verificationId、subjectHash、subjectVersion、suiteVersion，供 Work Harness 对账；不提供参数的直接 IKB eval 保留原兼容路径。

缓存报告和新计算都不能仅依赖锁内第一次 Subject。每个返回路径会 final reload，并比较 verification document/event identity、subject version/hash 和派生 `evaluationKey`；变化时释放旧 key 锁并有界重试。新报告在完成事件发布前失去绑定时，本轮新建且原始字节 hash 仍匹配的文件会被删除；若文件本来就存在但没有完成事件，则保持未索引隔离，不能命中缓存。同 key 的其他执行者继续在 evaluation-key 锁后读取唯一完成事件并复用，但也必须通过自己的 final reload。

新 `evaluation.completed` 事件必须显式保存 `hardGatePassed`，并与 `result`（blocked 对应 false，pass/partial 对应 true）及报告重算值一致。reader 只为历史缺字段事件保留按 result 映射的兼容路径；显式字段类型错误、与 result 冲突或与报告冲突都会拒绝复用。

final reload 是 Coordinator 的提交线性化点，而不是阻止任意进程直接改文件的文件系统事务。受支持的 Work Harness 路径在 evaluator 外层持有 task lock，直到 stdout 被校验并写完 terminal trigger，因此正常 mutator 不能进入检查后的窗口；直接 IKB 调用则承诺返回“该线性化点”的一致快照。绕过 Harness 锁的原子覆盖若发生在线性化点之后，属于后续状态，下一次 Subject hash/key 会反映它。

### Work Harness 领域评估合同

领域执行方在 task-dir 写入：

```json
{
  "schema": "work-harness-domain-evaluation-v1",
  "task_id": "demo",
  "run_id": "run-demo",
  "suite_id": "knowledge-extraction-r1",
  "suite_version": "v1",
  "grader_version": "deterministic-v2",
  "required": true,
  "hard_gate_passed": true,
  "result": "pass",
  "report_ref": "file://artifacts/domain-report.json",
  "report_hash": "64位小写sha256",
  "metrics": {
    "case_count": 30,
    "pass_rate": 1
  },
  "evidence_refs": [
    "file://artifacts/domain-report.json"
  ],
  "evaluated_at": "2026-07-23T00:00:00.000Z"
}
```

字段必须完整且只允许上述 snake_case 名称。`report_ref` 必须以 `file://` 开头：相对路径基于 task-dir，`file:///absolute/path` 形式的绝对路径允许；消费者用 `O_NOFOLLOW` 打开目标，对同一文件描述符执行 `fstat` 和字节读取，拒绝 symlink 与非普通文件并消除 path 两步读取窗口。`report_hash` 对该描述符读取的原始字节计算。`metrics` 只允许有限数字、布尔值和不以路径/URL 开头的安全字符串，字段名拒绝 prompt/output/path/url/payload/approval，值拒绝对象、数组和嵌套 payload；`evidence_refs` 至少保留一个合法引用。

`evaluated_at` 必须是带秒和时区的严格日历时间：闰年、每月天数、0～23 点、分钟/秒和 offset 均逐字段校验，不接受 `Date.parse` 会归一化的 2 月 30 日或 24 点。Python 写端与 TypeScript 读端共用 `fixtures/work-harness/domain-evaluated-at-vectors.json` 覆盖闰日、24 点和正负 offset。

未找到该文件时，L3 明确返回 `not_applicable`。合同和报告校验通过且结果为 pass 时，L3 返回真实 pass；blocked 时 L3 fail。`required=true` 的 blocked 会令整份 Eval Report `hardGatePassed=false`，Work Harness verify 可据此返回质量门禁阻断；`required=false` 的 blocked 保留 L3 fail 和 partial 结果，但不提升为硬门禁。身份不匹配、报告缺失、symlink 或 hash 篡改同时记入 L1 integrity 和 L3 reason code，不会退化成未注册。

## 改进闭环

同一 Suite 的 before/after 比较只输出 Case 状态、reason code 和变化列表，不自动修改 Prompt、Skill、角色、权限或门禁。重复失败仍由 IKB Outer Loop 聚类，形成 `pending_review` 候选，经过人工/独立 Verifier 和同一回归集验证后，才能更新规则或 Knowledge。

`projects/eval-plane/fixtures/` 下的 Work Harness、SpecX 和 pipeline 文件仍是合成回归输入，不含公司数据。`work-protocol` 用它们回归 Grader；`work-run-quality` 读取本机真实 task-dir。真实正文不会写入 Suite 或公共 fixture。
