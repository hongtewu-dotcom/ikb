# Codex / Claude Code Runtime Adapter

## 共同原则

适配器不是进程启动器。当前主 Agent 直接使用所在运行时的原生 subagent、background agent 或 team 能力；Work Harness 只生成节点输入、读取 Handoff、执行机械校验并更新状态。

## Codex

Codex 原生 Plan 是用户可见的步骤清单，不是 Harness 的持久化状态真源。主 Agent 应先形成原生 Plan，只有在需要持久化、并行节点、独立 verifier 或恢复时，才把需要交接的步骤镜像到 `plan.json`。

推荐调用顺序：

1. 主 Agent 在原生 Plan 中建立步骤。
2. 为每个子任务写 `nodes/<id>/input.md`，内容为 ContextPack + SpawnContract。
3. 使用当前 Codex 的原生 subagent 能力调用子任务。
4. 子任务将结构化 Handoff 写入 `nodes/<id>/handoff.json` 或返回给主 Agent。
5. 主 Agent 运行 `record-handoff`，脚本检查 Handoff/DAG 状态；主 Agent 或 verifier 另行执行 acceptance，再用原生 Plan 更新用户可见状态。
6. 终态前主 Agent 填充 `run-summary.template.json` 并运行 `record-summary`；该摘要是 IKB 等外部治理层的消费接口，包含证据/产物/知识引用和纠偏信号，不包含完整会话 transcript。

`input.md` 还会带上节点的 `read_scope`、`write_scope` 和 `dispatch_reasons`。主 Agent 只为值得独立调度的工作创建普通节点；微小的连续操作保留在一个节点的内部执行中。`next` 给出不发生写入范围重叠的建议波次，实际启动时 Harness 仍会做写入冲突门禁。

不要依赖 Codex 内部计划文件路径，也不要声称 CLI 可以更新 Codex 原生 Plan。需要从原生 Plan 启动 Harness 时，只导入一次显式 JSON 快照；后续以 `plan.json` 为真源。

Codex 的 spawn、等待、恢复和嵌套深度由当前 Codex 宿主提供；Harness 不假设可以递归创建子 Agent。需要跨多个独立方向时，优先由当前主 Agent 平铺调用多个子 Agent。

## Claude Code

Claude Code 的 Plan/Todo/Team 能力同样作为交互层。使用原生 Agent/Team 机制执行节点，采用相同的 ContextPack、Handoff 和任务目录。若使用 team，兄弟 agent 仍不能直接共享未经验证的结论；barrier 由主 Agent 控制。

Claude Code 的 Agent、background agent 和 Team 具有不同的等待、权限、上下文共享和隔离语义；Harness 只依赖“主 Agent 能启动并收到结果”这一最小能力，具体并发和嵌套上限由运行时决定。

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
