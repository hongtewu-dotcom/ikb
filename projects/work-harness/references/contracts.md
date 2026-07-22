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

## Terminal evaluation trigger

`verify` 先在任务锁内写完 `run-summary.json`、`verification.json`、`run-state.json` 和 `task.verified`，释放任务锁后再调用统一 Eval Plane。默认入口是同级 `projects/eval-plane/src/work-eval-cli.ts`；`WORK_HARNESS_EVAL_PLANE_SCRIPT` 可以覆盖入口，值为 `off` 时显式跳过。入口或 Node.js 不存在也会跳过，原 verification verdict 不变。

调用参数固定为：

```text
node --no-warnings=ExperimentalWarning --experimental-strip-types <script> --task-dir <absolute-task-dir> --suite work-run-quality
```

verify stdout 在原终态投影中增加 `evaluation`。成功时只投影 evaluator 返回的 `work-harness-evaluation-v1` 元数据；跳过或失败时投影 `status`、`suiteId` 和稳定 `reason`。主 `events.jsonl` 对应追加 `evaluation.trigger_completed`、`evaluation.trigger_skipped` 或 `evaluation.trigger_failed`，事件不保存完整报告和 evaluator stderr。

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
  "dispatch_reasons": ["independent_write"],
  "post_conditions": ["完成后的事实状态"],
  "acceptance": ["机械验收条件"],
  "output_contract": {"handoff": "node/handoff.json"},
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

## ContextPack

ContextPack 是最小充分上下文，不是完整 transcript：

| 字段 | 必须 | 说明 |
|---|---:|---|
| objective | 是 | 当前节点要解决什么 |
| scope | 是 | 可以读写什么 |
| known_facts | 是 | 已确认事实，附证据引用 |
| decisions | 否 | 已经确定的约束或取舍 |
| open_questions | 否 | 允许子 Agent 独立判断的问题 |
| evidence_refs | 否 | 文件、行号、链接、命令结果 |
| constraints | 是 | 技术、预算、时间、权限和副作用限制 |
| sibling_results | 否 | barrier 前禁止注入；barrier 后只注入必要结论 |

## Handoff

`status` 为 `blocked` 或 `failed` 时，`conclusion` 仍应说明已确认部分，`next_action` 必须说明主 Agent 下一步可选择什么。错误不能只写自然语言堆栈。

## Acceptance 类型

第一版由编排器保存 acceptance，并校验 Handoff/DAG/状态；真正的任务 acceptance 仍由主 Agent 或 verifier 执行。适合交给确定性脚本的检查包括：

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

`plan.json` 保存节点状态；`run-state.json` 保存当前运行状态；`events.jsonl` 只追加事件，便于恢复和审计。

`next` 会返回依赖已满足的节点以及按 `write_scope` 划分的 `parallel_waves`。即使运行时允许并行，`start-node` 仍会拒绝与当前运行节点存在重叠写入范围的节点，避免把有冲突的节点误判为可并行。

## Native plan snapshot

`import-native-plan` 接收主 Agent 显式生成的快照，不读取 Codex/Claude 内部文件，也不反向更新运行时 UI。原生计划通常只有文本和状态；缺少稳定 id 时，脚本按快照顺序生成 `native-step-001` 形式的临时 id。导入后主 Agent 必须补齐需要持久化节点的稳定 id、依赖和验收合同。
