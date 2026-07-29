# Work Harness Contracts

## Task

```json
{
  "schema": "work-harness-task-v1",
  "task_id": "stable-id",
  "run_id": "run-stable-id",
  "objective": "任务目标",
  "scope": ["允许访问的路径或系统"],
  "acceptance": ["可检查的完成条件"],
  "allowed_side_effects": [],
  "budget": {"max_agents": 3, "max_retries": 1},
  "runtime": "codex|claude-code|auto"
}
```

`init` 新写入时，一个 `scope` 参数只表示一个 scope。多个值使用重复的 `--scope`；词法门禁按空白、逗号、等号、分号和竖线分词，统一识别 Unix、Windows drive 与 UNC 绝对路径。一个元素包含多个绝对路径时拒绝写入。该门禁不回溯校验历史 task-dir。

## Run Summary

每个 Harness 任务在最终 `verify` 前必须记录一份 `run-summary.json`。它是给 IKB 或其他外部治理层消费的结构化接口，不包含完整会话 transcript，也不要求 Harness 直接分析知识。

```json
{
  "schema": "work-harness-run-summary-v1",
  "task_id": "stable-id",
  "run_id": "run-stable-id",
  "terminal_status": "completed|blocked|failed|cancelled",
  "verification": {"verdict": "pass|fail|not_run", "note": ""},
  "evidence_refs": ["artifact://...", "file://...", "node://..."],
  "artifact_refs": ["nodes/inspect/handoff.json"],
  "knowledge_refs": ["knowledge://..."],
  "correction_signals": [
    {
      "kind": "retry|manual_correction|verifier_rejection|unexpected_fix|runtime_gap|knowledge_feedback|recurrence",
      "reason_code": "stable_reason_code",
      "evidence_refs": ["artifact://..."],
      "artifact_refs": ["nodes/inspect/handoff.json"],
      "note": "可选的短说明"
    }
  ]
}
```

`correction_signals` 为空是合法结果。Harness 只负责保存和校验这些事实性信号；是否形成 Experience Record、是否聚类和是否晋升 Knowledge 由 IKB 或领域治理层决定。

## Domain evaluation projection

通用领域评估由 Eval Plane 或其他领域节点生成，Work Harness 只校验和保存投影，不做 L3 判定。固定合同如下：

```json
{
  "schema": "work-harness-domain-evaluation-v1",
  "task_id": "stable-id",
  "run_id": "run-stable-id",
  "suite_id": "flight-domain-regression",
  "suite_version": "v1",
  "grader_version": "grader-v3",
  "required": true,
  "hard_gate_passed": true,
  "result": "pass",
  "report_ref": "file://artifacts/domain-report.json",
  "report_hash": "64位小写sha256",
  "metrics": {"case_count": 30, "pass_rate": 1.0},
  "evidence_refs": ["file://artifacts/domain-report.json"],
  "evaluated_at": "2026-07-23T10:00:00Z"
}
```

`record-domain-evaluation <task-dir> --file <json>` 执行以下确定性校验：

- schema 固定为 `work-harness-domain-evaluation-v1`，只接受上述 snake_case 字段；task_id/run_id 必须与 task.json 一致。
- task_id、run_id、suite_id 匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`；suite_version、grader_version 匹配同字符集、最长 64 位的版本格式。
- required、hard_gate_passed 为布尔值；result 只允许 `pass|blocked`，且 `result=pass` 与 `hard_gate_passed=true` 必须等价。这是读写合同一致性校验，不是 Harness 的 L3 判定。
- metrics 必须是对象，key 使用 ID 格式，并拒绝包含 prompt/output/path/url/payload 或 approval payload 类名称。值只允许布尔、有限数字和非空字符串；字符串不能以 http/file/绝对路径/`~` 开头。null、数组和嵌套对象均非法。
- evidence_refs 至少一项，只接受 `artifact|source|node|run|case|knowledge|candidate://` 安全 URI 或非空 `file://`；evaluated_at 必须是包含秒和时区的 ISO-8601，并按真实日历与时区小时/分钟边界严格校验，不接受日期或 offset 归一化。
- report_ref 必须是 `file://`。相对路径基于 task-dir，绝对路径允许；目标必须是普通非 symlink 文件。report_hash 按文件原始字节计算，必须匹配 64 位小写 SHA-256。

校验通过后原子写入 `<task-dir>/domain-evaluation.json`，再追加 `domain_evaluation.recorded`。投影不会改写节点状态、terminal status 或 verification。

## Terminal evaluation trigger

`verify` 使用 Eval Plane 的 `work-run-quality@v4`，输入 subject 固定为 `work-harness-run-subject.v4`。任务锁覆盖 `run-summary.json`、`verification.json`、`run-state.json`、`task.verified`、外部 evaluator 调用和最终 trigger 落盘；同一 task 的下一次 verify 只能在前一次 trigger 终态后开始。默认入口是同级 `projects/eval-plane/src/work-eval-cli.ts`；`WORK_HARNESS_EVAL_PLANE_SCRIPT` 可以覆盖入口，值为 `off` 时显式跳过。入口或 Node.js 不存在也会跳过，原 verification verdict 不变。

调用参数固定为：

```text
node --no-warnings=ExperimentalWarning --experimental-strip-types <script> --task-dir <absolute-task-dir> --suite work-run-quality --verification-id <current-verification-id>
```

每次 verify 生成独立 verification_id，并同时写入 stdout、`task.verified` 和对应 trigger。evaluator 输出必须包含同值 `verificationId`、匹配 `^[0-9a-f]{64}$` 的 `subjectHash`、`subjectVersion=work-harness-run-subject.v4` 和 `suiteVersion=v4`。Harness 在 evaluator 前后通过固定的 canonical v4 projector 读取 current subject，要求 verificationId、runId、subjectVersion 和 subjectHash 绑定当前锁内快照，且两次 subjectHash 不变；任一字段缺失或错配都记录 `evaluation.trigger_failed(reason=invalid_output)`，不能放行。这些绑定字段写入 completed trigger 事件和 `verification.json.evaluation_triggers.<id>`；pending bookkeeping 先保存 verification_id 与预期版本。

终态写入后、trigger 前进程中止时，pending verification 保留原 id；下一次 verify 在锁内续跑该 id，不追加第二个 `task.verified`。pending 存在期间，add-node、start/heartbeat/recover、record-handoff、record-summary、record-domain-evaluation 和 native-plan import 等写命令全部 fail closed。历史 `verification.json` 只有初始化 `status=pending`、没有 `evaluation_triggers` 时不视为活跃 pending。

触发器解析 `<task-dir>/evaluations/work-run-quality/<evaluationKey>.json`，要求它是 canonical 路径上的普通非 symlink UTF-8 JSON 文件。v4 的 graderVersion 固定为 `deterministic-v1`；results 必须恰好包含以下 7 个唯一 case，不得缺失、重复或额外，且 level 固定为：`work-run-contract-integrity`/`work-run-dag-scope`/`work-run-node-closure`/`work-run-verification-chain`/`work-run-retry-budget`→L1，`work-run-recovery-quality`→L2，`work-run-domain-result`→L3。每个 result 的 expected/observed 必须为非空字符串，diagnosis 只能是 subject/grader/ground_truth/environment/unknown。

Harness 从五个 L1 status 以及 `work-run-domain-result.metrics.required=true` 时的领域 status 重算 hardGatePassed；hard gate 失败得到 blocked，否则全 case pass 得到 pass，仍有 fail 得到 partial。levels 的 total/pass/fail、failedCaseIds、reasonCodes 由 results 重算。`evaluation.completed` 的 totalCases、passedCases、failedCases 和去重 reasonCodes 也由完整 results 重算。stdout、报告和 `evaluations/events.jsonl` 中对应完成事件的 run、suite/version、subjectHash、subjectVersion、evaluationKey、hard gate 与 result 必须逐值一致；任何 self-reported 矛盾均拒绝。reportRef 固定为 `artifact://evaluation/work-run-quality/<evaluationKey>`，报告原始字节 SHA-256 必须等于完成事件 reportHash。evaluationKey 不能由 evaluator 任意指定，Harness 按 `sha256(runId + "\n" + suiteId + "\n" + suiteVersion + "\n" + subjectHash + "\n" + graderVersion)` 独立计算后精确比较。身份、路径或内容不一致按 `invalid_output` 处理，不能驱动质量放行。跳过或失败只投影稳定 reason，不保存 evaluator stderr。

退出码约定：正常完成或显式跳过返回 0；超时、非零退出、输出非法或启动失败返回 2；verification verdict 为 pass 但 `hardGatePassed=false` 时返回 3。返回 2 或 3 都不回写已经落盘的 terminal status；verdict 为 fail 时，质量评估 blocked 不额外改变退出码。

## Plan node

`plan.json` 是唯一持久化状态真源。Codex/Claude 原生 Plan 只作为当前会话的 UI 投影。

```json
{
  "id": "stable-node-id",
  "kind": "research|implement|verify|approval|native-plan-step",
  "goal": "节点目标",
  "depends_on": [],
  "read_scope": ["repo-a/src"],
  "write_scope": ["repo-a/src/orders"],
  "known_facts": ["已确认事实"],
  "evidence_refs": ["file://artifacts/source-evidence.json"],
  "decisions": ["已确定取舍"],
  "open_questions": ["允许执行方判断的问题"],
  "constraints": ["技术、权限或副作用约束"],
  "dispatch_reasons": ["independent_write"],
  "post_conditions": ["完成后的事实状态"],
  "acceptance": ["机械验收条件"],
  "output_contract": {"handoff": "nodes/stable-node-id/handoff.json"},
  "allowed_side_effects": [],
  "status": "pending|running|completed|blocked|failed"
}
```

### Node Granularity

节点是“值得独立调度的最小工作单元”，不是最小动作。几条命令、少量字段修改、同一文件内同一设计和同一验收标准的工作，留在一个节点内部，不继续拆成微任务。

创建普通节点时必须同时声明 `read_scope`、`write_scope`、`post_conditions`、`acceptance` 和 `dispatch_reasons`。`dispatch_reasons` 用来说明为什么值得独立调度：

- 硬理由满足一个即可：`independent_write`、`approval_boundary`、`independent_verification`、`independent_retry`。
- 软收益需要至少两个：`parallelism`、`context_reduction`、`evidence_separation`、`owner_separation`。

节点还必须能产出有意义的 Handoff；只有若干内部操作而没有独立结论、证据或验收的工作，应并回父节点。`native-plan-step` 是 Codex/Claude 原生 Plan 的粗粒度投影，可以暂不补齐这些调度字段；一旦需要独立执行或交接，应转换为普通 Harness 节点。

普通节点还必须显式提供非占位的 `known_facts` 和 `evidence_refs`，两者都至少一项。CLI 用重复的 `--known-fact` / `--evidence-ref` 接收；生成的 input.md 不写待补占位符。native-plan-step 不强制这两个字段。

`--decision`、`--open-question`、`--constraint` 均可选，写入 plan 节点和 input.md。未传 constraint 时写入通用约束“遵守 task.json 和节点 allowed_side_effects”；decision/open_question 未传时保留空数组。

read_scope/write_scope 的一个元素只表示一个 scope。新 add-node 使用与 runtime subject 相同的分词和绝对路径识别规则；validate 仍能读取旧格式。并行建议和 start-node 门禁使用 canonical path：消除 `.`、`..`、重复分隔符，Windows 路径大小写不敏感，根范围与其所有后代冲突。plan 中保留调用方传入的原始展示值。

## ContextPack

ContextPack 是最小充分上下文，不是完整 transcript：

| 字段 | 必须 | 说明 |
|---|---:|---|
| task_schema/task_created_at | 是 | task 合同版本与创建时间 |
| task_id/run_id | 是 | 任务与运行身份 |
| objective | 是 | 当前节点要解决什么 |
| task_runtime | 是 | task 创建时的 runtime |
| scope | 是 | 可以读写什么 |
| task_acceptance | 是 | 任务级验收条件 |
| task_allowed_side_effects | 是 | 任务级允许副作用 |
| budget | 是 | max_agents 与 max_retries |
| known_facts | 普通节点是 | 已确认事实；不得使用 TODO/TBD/待补占位符 |
| decisions | 否 | 已经确定的约束或取舍 |
| open_questions | 否 | 允许子 Agent 独立判断的问题 |
| evidence_refs | 普通节点是 | 文件、行号、链接、命令结果；至少一项 |
| constraints | 是 | 技术、预算、时间、权限和副作用限制 |
| node_id/kind/goal | 是 | 节点身份、类型和唯一目标 |
| depends_on | 是 | 前置节点 |
| read_scope/write_scope | 是 | 节点级读写范围 |
| post_conditions/acceptance | 是 | 节点完成事实与机械验收 |
| dispatch_reasons | 普通节点是 | 独立调度理由 |
| output_contract | 是 | 结构化输出位置 |
| node_allowed_side_effects | 是 | 节点级允许副作用 |
| initial_status | 是 | 创建时固定为 pending |
| sibling_results | 否 | barrier 前禁止注入；barrier 后只注入必要结论 |

## Handoff

新 execution 的 Handoff 固定包含执行身份：

```json
{
  "task_id": "stable-id",
  "run_id": "run-stable-id",
  "node_id": "stable-node-id",
  "attempt": 1,
  "execution_id": "execution-...",
  "status": "completed|blocked|failed",
  "conclusion": "结论",
  "evidence": [],
  "artifacts": [],
  "validation": [],
  "risks": [],
  "next_action": "下一步"
}
```

`evidence`、`artifacts`、`validation` 和 `risks` 都是字符串数组；每个元素必须是非空字符串，对象、null 和空白字符串均拒绝。空数组在 Handoff 结构层合法，但 Eval 可能按质量合同把缺少 evidence 或 validation 判为阻断。

record-handoff 在任务锁内把这五个身份字段与当前 execution 对账，并确认 lease 尚未过期。旧 attempt、旧 execution_id、跨节点结果和过期 lease 一律拒绝。run-state execution、`nodes/<id>/execution.json`、对应 `node.started` 或 `node.handoff_recorded` 任一含 execution_id 即判 managed；run-state、descriptor 与当前 attempt 事件必须完整且同值，不能因删除一个字段而降级。只有四类 managed 证据都不存在的历史 execution 才沿用旧 Handoff 结构。`status` 为 `blocked` 或 `failed` 时，`conclusion` 仍应说明已确认部分，`next_action` 必须说明主 Agent 下一步可选择什么。

## Acceptance 类型

第一版由编排器保存 acceptance，并校验 Handoff/DAG/状态；真正的任务 acceptance 默认由主 Agent 执行。只有用户明确要求或高风险语义无法由确定性检查覆盖时，才增加最多一个独立 verifier，不创建双 reviewer。适合交给确定性脚本的检查包括：

- `file_exists`
- `json_field`
- `output_contains`
- `command_exit_code`
- `changed_files_subset`
- `test_passed`

不把“设计合理”“代码优雅”“结论正确”伪装成简单布尔检查。

## 状态

```text
initialized → running → verifying → completed
                    ├→ blocked
                    └→ failed → running (有限重试)
```

节点必须经过 `pending → running → completed|blocked|failed`。`start-node` 检查依赖和预算，`record-handoff` 不能越过 `running` 或前置节点；失败/阻塞只有在重试预算未耗尽时才能重新启动。

`plan.json` 保存节点状态；`run-state.json` 保存当前运行状态；`events.jsonl` 保存事件，便于恢复和审计。validate 与 next 在一次共享锁内读取 task/plan/run-state 并基于同一快照计算。

`next` 会返回依赖已满足的节点以及按 `write_scope` 划分的 `parallel_waves`。即使运行时允许并行，`start-node` 仍会拒绝与当前运行节点存在重叠写入范围的节点，避免把有冲突的节点误判为可并行。

### Transition journal

add-node、start、heartbeat、recover-stale、record-handoff 和 verify 的跨文件更新先原子写入 `.transition-journal.json`。node.add 的同一 journal 同时包含完整 plan 快照与 `nodes/<id>/input.md` 文本，因此 journal 建立前不会出现孤立 ContextPack，任一 target 中断后也可确定性补完。journal 包含 transition_id、完整目标快照和待追加事件；重放事件时按 transition_id 幂等。每个目标仍使用临时文件、fsync 和原子替换。

进程在 journal、任一目标或事件写入后中止时，journal 保留。下一次取得独占任务锁的写操作先重放并补完，再执行自己的逻辑。validate、next 和 check-stale 不做隐式恢复；它们取得共享锁后发现 pending journal 会报错，不能把 torn snapshot 当成正常状态。

### Execution identity and lease

`start-node` 的新调用必须显式声明：

- `executor_kind=parent|subagent|team`
- `runtime=codex|claude-code`
- `executor_id`：subagent/team 必填，parent 可为空
- `lease_seconds`：默认 900，允许 30～3600

`node.started` 事件保存上述身份、attempt 和 lease_expires_at；可恢复状态保存在 `run-state.json.executions.<node_id>`：

```json
{
  "attempt": 1,
  "execution_id": "execution-...",
  "executor_kind": "subagent",
  "runtime": "codex",
  "executor_id": "codex-agent-42",
  "status": "running",
  "started_at": "2026-07-23T10:00:00Z",
  "last_heartbeat_at": "2026-07-23T10:00:00Z",
  "heartbeat_count": 0,
  "lease_seconds": 900,
  "lease_expires_at": "2026-07-23T10:15:00Z"
}
```

每次 start-node 都生成新的 execution_id。相同内容还会写入 `nodes/<node_id>/execution.json`，descriptor 额外包含 schema、task_id、run_id 和 node_id，状态恢复与 validate 会逐字段对账。run-state、descriptor、`node.started` 与当前 attempt 的 `node.handoff_recorded` 共同构成 managed 身份证据；任一处出现 execution_id 后，缺失或错配都属于 invalid，而不是 legacy。

新 execution 的 `heartbeat` 必须传 `--execution-id`，只允许当前 id 在 lease 未到期时续期。旧 id、缺失 id 或过期 lease 都会被拒绝；历史 execution 没有 execution_id 时允许不带参数调用，并在输出与事件中标记 `identity_mode=legacy`。到期后 heartbeat 和再次 start-node 都不能抢占。

`check-stale` 使用共享读锁，不写 task 文件或事件。有 lease 时按 lease_expires_at 判断；历史 running 节点没有 executions/lease 时，只有显式传入 `--older-than-seconds` 才判断，活动时间优先取该节点最后一次 `node.started`/`node.heartbeat`，找不到时回退 `run-state.updated_at`。

`recover-stale` 是唯一恢复入口。它重新确认 stale 后，把节点从 running 显式转为 failed，清理 current_nodes，更新 execution 终态并追加 `node.stale_recovered`。如果当前 attempt 仍在 `1 + max_retries` 上限内，后续 start-node 可以重试；预算耗尽时仍允许恢复为 failed，但不得再次启动。failed/blocked 节点成功重启时，同时清理指向该节点的 failed_node/blocked_node 陈旧投影。没有 lease 的历史节点恢复时必须同时给出 `--older-than-seconds`，不会因读取而自动迁移。

## Native plan snapshot

`import-native-plan` 接收主 Agent 显式生成的快照，不读取 Codex/Claude 内部文件，也不反向更新运行时 UI。原生计划通常只有文本和状态；缺少稳定 id 时，脚本按快照顺序生成 `native-step-001` 形式的临时 id。导入后主 Agent 必须补齐需要持久化节点的稳定 id、依赖和验收合同。
