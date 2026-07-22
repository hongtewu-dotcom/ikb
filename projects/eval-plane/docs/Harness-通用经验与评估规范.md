# Harness 通用经验与评估规范

这份文档回答两个问题：Harness 到底应该记什么，以及怎样把“看见问题”变成可以验证的改进。它不是某个模型的 Prompt，也不是把运行日志堆在一起；它是 IKB 的控制面、证据面和评估面之间的共同契约。

## 先说结论

Harness 的核心不是“多一个 Agent”，而是一个可恢复、可审计、可评估的执行控制面：

```text
Task
  → Run
  → Loop 轮次
  → Step
  → Handoff
  → Gate
  → Artifact / Verifier
  → Approval / Action
  → 评估结果
  → 人工确认的改进候选
```

每一层都必须有稳定 ID、输入/输出引用、状态、失败出口和证据。模型输出可以帮助判断，但不能替代这些结构化记录。

## 应该记什么

### 1. 记“可重建的事实”，不记无界的临时上下文

IKB 的 Source、Knowledge、Artifact、Ledger 分层如下：

| 层 | 应记录 | 不承担的职责 |
| --- | --- | --- |
| Source | 原始材料、版本、定位、scope、raw/normalized hash | 不直接变成结论 |
| Knowledge | 可复用结论、适用条件、边界、步骤、验证方法、置信度 | 不保存一次 Run 的状态 |
| Artifact | context、分析、草稿、Verifier 报告、评估报告 | 不替代不可变事件 |
| Ledger | 状态转移、交接、门禁、批准、动作、哈希链 | 不保存原文和 Prompt |

Harness 事件只保存 `source_refs / artifact_refs / evidence_refs` 和 hash；原文留在本地 Source/Artifact。这样可以在本地重放，观测报告只是 Ledger 的派生视图，不会成为第二个真相源。

### 2. 每个 Run 记一条完整的控制轨迹

当前 IKB 的结构化事件契约是 `harness-events.v1`，包括：

- `loop_started / loop_finished`：Loop 名称、轮次、上下文 hash、输入/输出引用、终态和下一动作。
- `step_started / step_finished`：步骤、角色、Skill、输入/输出引用和 hash、状态、错误码。
- `handoff`：交接双方、交接的 Artifact/Source 引用、契约版本。
- `gate_evaluated`：G0～G6、决策、原因码、证据引用、门禁版本。
- `verification_completed`：整体结果、每个检查项、证据引用和关联 Artifact。
- `evaluation_completed`：评估版本、套件、Case 计数、结果和评估 Artifact；它和 Verifier 分开，避免把“检查产物”与“回归集结果”混成一个布尔值。
- `artifact_linked`：产出/消费/验证/替代关系和 lineage。
- `approval_checked / action_executed`：批准决定、动作、目标/载荷 hash、副作用等级、执行结果。

`run.finished(status=succeeded)` 只能说明控制面结束；没有 Verifier、必要 Gate 和 Artifact 时，评估结果必须是 `block` 或 `partial`，不能自动当作质量通过。

### 3. 人物知识按“证据积累—周期重建”记

人物不是一次消息抽取结果。每次增量同步只追加 Source delta；人物证据 dossier 在批次结束或计划任务时重建；默认按周做 consolidation，只有满足新增独立 Episode、身份映射变化或明确要求才提前重建。人物 Knowledge 还要单独记录：

- `identity_confidence`：是否确定是这个人；
- `pattern_confidence`：是否足以归纳稳定偏好/工作方式；
- `independent_episode_count`：来自多少个相互独立的场景；
- 时间状态、推断边界和未知项。

“出现过一次”“在同一个群”“被别人提到”只属于证据，不能直接写成人物结论。

## 十条可泛化 Harness 经验

以下内容是对公开实践的归纳，不是任何单一项目的原文结论；落地时仍需用自己的回归集验证。

### 1. 控制面和模型分离

调度状态、重试、并发、超时、释放和停止条件由 Harness 控制，模型只负责当前步骤的语义工作。这样模型换代不会改变账本语义。OpenAI Symphony 把工作项状态、claim、retry/backoff、stall 检测和 workflow policy 放在编排器中，并强调调度状态只能由编排器修改。

### 2. 步骤边界同时是可靠性边界和观测边界

把大任务切成可检查的步骤，每一步有输入快照、输出 Artifact、状态和失败类型。LangGraph 的持久化/任务模型也把每一步作为 checkpoint、重放和恢复的边界；IKB 对应 `step_*`、`artifact_linked` 和 `verification_completed`。

### 3. 恢复必须幂等，重试不能重复副作用

每个外部动作都要有稳定的 `action_id + target_hash + payload_hash`。重试遇到完全相同身份可以复用结果；目标或载荷变化则必须阻断并重新 Approval。恢复不是“再跑一遍 Prompt”，而是从 checkpoint 继续未完成的步骤。

### 4. 人工介入是可恢复状态，不是聊天插话

需要人判断时，Run 进入 `awaiting_approval`，保存 thread/run 标识、待批准动作、目标/载荷 hash 和恢复点；批准、编辑、拒绝都产生事件。LangGraph 的 interrupt/checkpointer 采用同样思路：暂停后用稳定 thread id 恢复，不丢失之前的状态。

### 5. 上下文是版本化 Artifact，不是无限拼接历史

Context Pack 要有查询意图、来源引用、版本/hash、scope 和使用政策。只把当前步骤需要的证据放入上下文；完整原文留在 Source。上下文发生变化时重新生成并建立 lineage，不能让 Agent 静默使用旧版本。

### 6. 确定性门禁先于 LLM 评判

来源存在、scope 一致、结构完整、哈希匹配、Approval 绑定、Ledger 完整性等可以确定性检查的内容必须由代码检查。模型评判只做 advisory，先记录置信度和反例，再决定是否进入阻断门禁。评估数据集和 grader 的 schema/version 要固定，避免“评估器自己漂移”。

### 7. 三种可观测性要分开

可观测性至少有三层：

- **组件可观测性**：改了哪些文件/Artifact，是否可回滚；
- **经验可观测性**：哪些 Source、知识和历史案例支持当前判断；
- **决策可观测性**：当时预测了什么，后续结果是否验证或推翻。

只看 Trace 时间线不能证明知识正确；只看知识正文也不能证明执行真的使用了它。

### 8. 终态、验收、质量是三个字段

`succeeded` 表示运行器完成，Verifier 结果表示证据检查结果，Task acceptance 表示业务验收。三者必须分别记录，不能用一个布尔值压扁。成功 Run 可以得到 `terminal=succeeded, quality=blocked`，这不是矛盾，而是诚实的状态。

### 9. Outer Loop 只能提出候选，不能直接修改系统

把重复失败按 `reason_code + role + skill + scope + gate_version` 聚类；达到样本阈值才生成 pattern。候选必须带失败事件、Artifact、预期改善指标和回归用例；人工确认后才能进入 Skill/Knowledge Card，应用后还要跑回归集并支持回滚。失败少、原因混杂或数据跨 scope 时只记录观察，不提规则。

### 10. 指标衡量结果，不衡量产量

知识条数、Trace 数、Token 数和 Agent 次数都不是价值指标。应观察：引用后真实验证率、首次验收通过率、人工修改幅度、恢复成功率、重复副作用数、scope/Approval 违规数、过期和冲突率。`admit` 和 `skip` 都是正常结果，零知识也可能是正确的策展结论。

## IKB 的确定性评估规范

代码内置 `harness-eval.v1` 和 12 个合成 Case，可通过下面命令运行：

```bash
./bin/ikb harness eval --json
./bin/ikb harness eval --case M2-terminal-success-is-not-quality --json
```

12 个 Case 覆盖：准入/跳过、缺证据、scope、完整质量链、终态不等于质量、Approval 匹配/隔离、恢复幂等/冲突重试、Outer 聚类/不提案，以及原始内容/路径隔离。评估器只读取事件和合成输入，不调用模型或外部观测服务；每个结果包含 `expected / observed / failedInvariants / metrics`。

第一阶段验收条件：

1. 12/12 Case 可重复运行且结果稳定；负向 Case 必须阻断。
2. `pnpm check`、`knowledge lint`、`doctor` 和 `ledger verify` 全部通过。
3. 真实 Run 的质量结论只有在 Verifier、Evaluation、Artifact 和必要 Gate 齐全时才允许 `pass`。
4. HTML 报告服务不可用时，Ledger、Run、Approval 和 Artifact 不受影响；服务恢复后可按 event id 重读。
5. Outer 候选始终为 `pending/human_review`，没有自动 Prompt、Skill、权限或门禁修改。

Outer Loop 的只读入口是：

```bash
./bin/ikb harness patterns --json --min-samples 3
```

它只从 Ledger 聚类 `gate/verification/evaluation/step/action` 失败，输出带 hash 证据和回归 Case 的 `pending_review` 候选；当前没有自动写入 Candidate Pool，也不会改动任何 Skill 或 Knowledge。人工确认后再显式执行候选入池，入池后的规则仍需回归验证。

## 从公开实践吸收的依据

- [OpenAI Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md)：编排器状态机、重试/退避、停滞检测和仓库内 workflow policy。
- [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-python/tracing/)：Trace/Span 对 LLM、工具、handoff、guardrail 和自定义事件的结构化记录。
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) 与 [HITL](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)：checkpoint、重放、暂停、批准/编辑/拒绝和稳定 thread id。
- [OpenAI Evals / graders](https://platform.openai.com/docs/api-reference/graders?api-mode=chat)：数据集 schema、确定性检查与 grader 分离，评估版本应固定。
- [AHE: Agent Harness Engineering](https://arxiv.org/abs/2604.25850)：component、experience、decision 三类 observability 的研究归纳。

这些资料说明了“应该记录什么、怎样恢复和怎样评估”的常见方向，但不自动证明某条知识或某个工作流有效。IKB 的结论必须回到本地 Source、Artifact、Verifier 和真实 Task 的结果。
