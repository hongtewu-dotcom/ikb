# Codex / Claude Code Runtime Adapter

## 共同原则

适配器不是进程启动器。当前主 Agent 直接使用所在运行时的原生 subagent、background agent 或 team 能力；Work Harness 只生成节点输入、读取 Handoff、执行机械校验并更新状态。

默认不创建 reviewer 节点。Codex 和 Claude Code 都先由主 Agent 执行测试、机械验收和已有 Eval Plane；只有用户明确要求或高风险语义判断缺少确定性证据时，才启动最多一个独立 verifier。适配器不得并行生成双 reviewer，也不得在每轮修复后换一组 reviewer 重开审查。

## Codex

Codex 原生 Plan 是用户可见的步骤清单，不是 Harness 的持久化状态真源。主 Agent 应先形成原生 Plan，只有在需要持久化、并行节点、独立 verifier 或恢复时，才把需要交接的步骤镜像到 `plan.json`。

推荐调用顺序：

1. 主 Agent 在原生 Plan 中建立步骤。
2. 用 add-node 显式传入真实 known_facts/evidence_refs，按需传 decision/open_question/constraint，脚本生成 `nodes/<id>/input.md`。该文件同时投影 task/node allowed_side_effects、depends_on、预算、output_contract 和其余 SpawnContract 字段。
3. 调用 start-node，记录 `executor_kind`、实际 runtime 和 executor_id。subagent/team 的 executor_id 必填，parent 可空；保存 stdout 返回的 execution_id，并读取 `nodes/<id>/execution.json`。
4. 使用当前 Codex 的原生 subagent 能力调用子任务；长任务在 lease 到期前调用 `heartbeat --execution-id <current-id>`。
5. 子任务将结构化 Handoff 写入 `nodes/<id>/handoff.json` 或返回给主 Agent。新 execution 必须回传 task_id、run_id、node_id、attempt 和 execution_id。
6. 主 Agent 运行 `record-handoff`，脚本检查 Handoff/DAG 状态；主 Agent 执行 acceptance，只有命中独立验证条件时才追加一个 verifier，再用原生 Plan 更新用户可见状态。
7. 终态前主 Agent 填充 `run-summary.template.json` 并运行 `record-summary`；该摘要是 IKB 等外部治理层的消费接口，包含证据/产物/知识引用和纠偏信号，不包含完整会话 transcript。

一个 scope 参数只表示一个 scope；多个路径使用重复参数。词法门禁统一处理空白、逗号、等号、分号和竖线中的 Unix/Windows 绝对路径。`next` 与 start-node 使用 canonical path 判断冲突，不能用 `.`、`..`、重复分隔符、大小写或根路径别名绕过。

不要依赖 Codex 内部计划文件路径，也不要声称 CLI 可以更新 Codex 原生 Plan。需要从原生 Plan 启动 Harness 时，只导入一次显式 JSON 快照；后续以 `plan.json` 为真源。

Codex 的 spawn、等待、恢复和嵌套深度由当前 Codex 宿主提供；Harness 不假设可以递归创建子 Agent。需要跨多个独立方向时，优先由当前主 Agent 平铺调用多个子 Agent。

## Claude Code

Claude Code 的 Plan/Todo/Team 能力同样作为交互层。使用原生 Agent/Team 机制执行节点，采用相同的 ContextPack、Handoff 和任务目录。若使用 team，兄弟 agent 仍不能直接共享未经验证的结论；barrier 由主 Agent 控制。

Claude Code 的 Agent、background agent 和 Team 具有不同的等待、权限、上下文共享和隔离语义；Harness 只依赖“主 Agent 能启动并收到结果”这一最小能力，具体并发和嵌套上限由运行时决定。

Claude Code Agent/background agent 记录为 `executor_kind=subagent`，Team 记录为 `executor_kind=team`；executor_id 使用宿主返回的稳定 agent/team 标识。主会话直接执行时记录为 `parent`，不要把缺失身份默认为 parent。

execution_id 由每次 start-node 生成，与 Claude 的 agent/team id 不是同一个字段。重试必须使用新的 execution_id；旧 Agent 即使晚到，也不能为新 attempt 续 lease 或提交 Handoff。

适配器不得自行把 managed execution 降级为 legacy。run-state、execution descriptor、`node.started` 或 `node.handoff_recorded` 任一带 execution_id 时，四方身份投影都必须与当前 attempt 一致；字段缺失或错配应停止并修复任务状态。只有这些 managed 证据全部不存在的历史任务才允许使用无 execution_id 的兼容调用。

## 运行时差异

| 能力 | Codex | Claude Code | Harness 处理 |
|---|---|---|---|
| 计划展示 | 原生 Plan | Plan/Todo | 不替换；必要节点单向镜像到 Harness |
| 子 Agent | 原生 subagent | Agent/Team | 不另起 Runtime |
| 并行 | 由当前运行时决定 | 由当前运行时决定 | 只提供依赖和并行建议 |
| 状态真源 | 当前会话 + task dir | 当前会话 + task dir | task dir 中的 plan/run-state 唯一可恢复 |
| 观测 | 可选 Opik | 可选 Opik | 不影响执行正确性 |

## 失败处理

运行时调用失败时，主 Agent 记录 `failed` Handoff；只有根据 `retryable`、预算和副作用策略判断允许时才重试。不要让脚本悄悄启动另一个模型进程，也不要把失败伪装成 `blocked` 之外的成功。

运行时失联时先执行 `check-stale`。该命令只读，不会接管节点；确认 stale 后显式执行 `recover-stale`，节点进入 failed 并保留原 executor/lease 事件，再由调用方按预算决定是否重新 start-node。历史任务没有 lease 时必须传 `--older-than-seconds`，不能把“缺 lease”直接当成可抢占。

状态转换中止时不要手工拼接 plan、ContextPack、run-state 或 events。add-node 已把 plan 节点和 `nodes/<id>/input.md` 放入同一 `.transition-journal.json`；下一次写命令取得独占锁后会重放 journal。validate、next、check-stale 发现 pending journal 时只报错，不做隐式写入。

## 领域评估交接

Eval Plane 产出 `work-harness-domain-evaluation-v1` 后，调用 `record-domain-evaluation`。Harness 使用与 TypeScript 读取端同构的字段安全规则，校验 snake_case 合同、任务身份、Suite/Grader 版本、result/hard gate 等价关系、安全 scalar metrics、evidence refs、报告普通文件和 SHA-256，再原子保存投影。L3 结论仍由 Eval Plane 负责，Runtime Adapter 不二次判定。

终态 verify 调用 `work-run-quality@v4`，输入合同是 `work-harness-run-subject.v4`。任务锁覆盖 `task.verified`、evaluator 和 trigger，调用参数携带当前 `--verification-id`。Harness 用固定的 canonical v4 projector 在 evaluator 前后确认 current subjectHash 未变化，再将 stdout、报告、Eval 完成事件中的 run/suite/version、subjectHash、evaluationKey、hard gate、派生 result、reportRef、canonical reportPath 和报告原始字节 SHA-256 逐值对账。grader 必须是 `deterministic-v1`，报告必须是固定 7-case/level 集合；Harness 重算 levels、required-domain hard gate、最终 result，以及完成事件的 total/pass/fail/reasonCodes。evaluationKey 按 `sha256(runId + "\n" + suiteId + "\n" + suiteVersion + "\n" + subjectHash + "\n" + graderVersion)` 独立计算。任一不一致按 `invalid_output` fail closed。崩溃 pending 只能由 verify 复用原 id 恢复，其他写命令在此期间 fail closed。
