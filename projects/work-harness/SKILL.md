---
name: work-orchestrator
description: 通用复杂任务编排 Skill。用于在 Codex 或 Claude Code 当前会话内，判断是否需要拆分子任务，生成可执行的任务节点和 ContextPack，调用当前运行时的原生 subagent，并通过结构化 Handoff、验收、barrier 和 checkpoint 收敛结果。适用于代码调研、跨仓改动、故障排查、PRD/技术方案分析、文档整理等需要串并行协作、恢复或独立验证的任务；不适用于简单单文件修改，也不替代 IKB 的知识领域 Agent。
---

# Work Orchestrator

这是一个轻量编排层，不是新的 Agent Runtime。主 Agent 始终留在当前 Codex 或 Claude Code 会话内，实际执行由当前运行时的原生 subagent 能力完成。本 Skill 只统一拆解、上下文传递、结果交接和确定性验收。

## 1. 先决定是否启用持久化编排

默认沿用 Codex/Claude Code 自带的计划步骤。只有满足任一条件时，才创建 `.agent-work/<task-id>/` 并启用 Harness：

- 有两个以上可以独立调查或实施的方向。
- 任务会跨越多轮会话，需要恢复或重试。
- 存在明确的依赖关系、barrier、独立 verifier 或审批点。
- 需要记录子任务产物、证据、失败原因或预算。
- 涉及多个仓库、长时间运行或外部副作用。

简单任务只使用当前运行时的原生 Plan/Todo，不要为了使用 Harness 而创建文件。

## 2. 与 Codex 原生计划兼容

Codex/Claude Code 原生计划是当前会话的 UI 投影；Harness 的 `plan.json` 和 `run-state.json` 是唯一持久化真源。不要维护两套可独立变化的状态，也不要依赖运行时内部计划文件。

规则如下：

1. 先按当前 Codex/Claude Code 的方式分析和拆步骤。
2. 每个需要独立执行、交接或校验的原生步骤映射为一个 Harness node；纯粹的展示性步骤可以只保留在原生计划中。
3. 映射时由主 Agent 生成稳定 node id、依赖、输出合同和 ContextPack；Codex 原生计划的文本和勾选状态不作为状态真源。
4. 节点状态变化只写 `plan.json`/`run-state.json`，主 Agent 再用当前运行时原生计划能力更新用户可见步骤。
5. `import-native-plan` 只用于显式的一次性启动快照，不会反向修改 Codex/Claude 的原生计划，也不能替代主 Agent 的 DAG 依赖判断。

原生计划投影格式：

```json
{
  "steps": [
    {"id": "inspect", "step": "检查现状", "status": "completed", "depends_on": []},
    {"id": "implement", "step": "实施修改", "status": "pending", "depends_on": ["inspect"]}
  ]
}
```

## 3. 编排流程

```text
理解任务 → 判断复杂度 → 形成原生 Plan
    → 必要时 init Harness → ContextPack
    → 按 depends_on 启动当前 Runtime 的原生 subagent
    → barrier 汇总 → verifier 验收
    → 更新计划/状态/事件 → 主 Agent 交付
```

并行规则：

- 无依赖且默认只读的节点可以并行。
- 共享同一写入目标、依赖前序产物或有外部副作用的节点串行。
- 同一波节点不能看到兄弟节点的结论；barrier 后才汇总。
- Harness 拓扑默认最多两层；不要假设 Codex 或 Claude 运行时都支持嵌套 subagent，运行时不支持时改为主 Agent 平铺多个子任务。
- 主 Agent 不因子 Agent 报错而自行吞掉问题；必须记录失败 Handoff，再决定重试、换方案或请求审批。
- 任务最终验收前必须记录 `run-summary.json`；它只保存证据引用、产物引用、知识引用和纠偏信号，不保存完整 transcript。

节点粒度规则：

- 节点是“值得独立调度的最小工作单元”，不是最小动作；几条命令、少量字段修改、同一文件内同一设计和同一验收的工作留在节点内部。
- 普通节点必须声明 `read_scope`、`write_scope`、`post_conditions`、`acceptance` 和 `dispatch_reasons`，并能产出有意义的 Handoff。
- `dispatch_reasons` 至少满足一个硬理由，或两个软收益。硬理由：`independent_write`、`approval_boundary`、`independent_verification`、`independent_retry`；软收益：`parallelism`、`context_reduction`、`evidence_separation`、`owner_separation`。
- `next` 输出按写入范围切开的 `parallel_waves`；`start-node` 会再次拒绝与正在运行节点重叠写入范围的节点。
- `native-plan-step` 只是原生 Plan 的粗粒度投影，可以暂不补齐上述调度字段；需要独立执行、交接或重试时再转换为普通节点。

## 4. SpawnContract：主 Agent 发给子 Agent 的内容

子 Agent prompt 只注入任务所需上下文，不塞完整会话记录：

```markdown
## ContextPack
- objective: 当前总目标
- scope: 本节点允许读取/修改的范围
- known_facts: 已确认事实
- decisions: 已做决策
- open_questions: 尚未确定的问题
- evidence_refs: 文件、行号、链接或命令结果
- constraints: 技术、时间、权限和副作用限制

## SpawnContract
- goal: 本节点唯一目标
- post_conditions: 完成后必须成立的条件
- acceptance: 主 Agent 可以机械检查的条件
- output_contract: 必须生成的文件或结构化结果
- forbidden: 不得执行的动作

## 执行要求
独立判断，不预设主 Agent 的结论；不要读取兄弟节点的结果；遇到阻塞返回结构化 blocked Handoff。
```

`ContextPack` 应保留事实、证据和约束，删除无关历史、主 Agent 的猜测和兄弟节点结论。详细字段见 [contracts.md](references/contracts.md)。

## 5. Handoff 与验收

子 Agent 返回或写入：

```json
{
  "status": "completed|blocked|failed",
  "conclusion": "结论",
  "evidence": ["证据引用"],
  "artifacts": ["产物路径"],
  "validation": ["执行过的检查"],
  "risks": ["未知或风险"],
  "next_action": "下一步"
}
```

主 Agent 必须自己运行 acceptance；子 Agent 自报完成不等于完成。CLI 只校验 Handoff 结构、DAG、状态和产物存在性，不假装执行自然语言 acceptance。验收优先使用文件存在、JSON 字段、命令退出码、测试结果、diff 范围等机械条件，语义质量交给独立 verifier。

verifier 接收产物、证据和验收标准，不接收 producer 的完整辩护文本。通过后才能把任务标记为 `verified/completed`。

## 6. CLI

脚本只管理任务目录、状态和校验，不启动 Codex/Claude Code，不调用模型：

```bash
python3 .agents/skills/work-orchestrator/scripts/work_harness.py init \
  --task-id booking-analysis \
  --objective "分析预订链路改造影响" \
  --acceptance "输出影响范围和证据引用"

python3 .agents/skills/work-orchestrator/scripts/work_harness.py add-node .agent-work/booking-analysis \
  --node-id inspect-booking \
  --goal "调查预订入口和调用链" \
  --read-scope "repo-a/src" \
  --dispatch-reason context_reduction \
  --dispatch-reason evidence_separation \
  --post-condition "形成可引用的调用链结论" \
  --acceptance "handoff 中包含证据路径"

python3 .agents/skills/work-orchestrator/scripts/work_harness.py validate .agent-work/booking-analysis
python3 .agents/skills/work-orchestrator/scripts/work_harness.py next .agent-work/booking-analysis
python3 .agents/skills/work-orchestrator/scripts/work_harness.py start-node .agent-work/booking-analysis \
  --node-id inspect-booking
# 子 Agent 返回 nodes/inspect-booking/handoff.json 后：
python3 .agents/skills/work-orchestrator/scripts/work_harness.py record-handoff \
  .agent-work/booking-analysis --node-id inspect-booking \
  --file .agent-work/booking-analysis/nodes/inspect-booking/handoff.json
python3 .agents/skills/work-orchestrator/scripts/work_harness.py record-summary \
  .agent-work/booking-analysis --file .agent-work/booking-analysis/run-summary.template.json
python3 .agents/skills/work-orchestrator/scripts/work_harness.py verify \
  .agent-work/booking-analysis --verdict pass
python3 .agents/skills/work-orchestrator/scripts/work_harness.py import-native-plan \
  .agent-work/booking-analysis --file native-plan.json
```

`sync-native-plan` 仍保留为兼容别名，但语义同样是单向导入快照，不是双向同步。

在 canonical IKB 总目录中，`verify` 释放任务锁后会自动调用同级 Eval Plane 的 `work-run-quality@v1`，真实读取当前 task-dir。报告落在 `<task-dir>/evaluations/work-run-quality/`；评估环境失败返回 2，pass verdict 被 L1 质量门阻断返回 3，已经落盘的 terminal status 不回写。缺少同级 Eval Plane 或 Node.js 时会显式记录 `evaluation.trigger_skipped`，不静默伪装成已评估。

执行前先读 [contracts.md](references/contracts.md)；需要适配当前运行时的提示词和计划映射时读 [runtime-adapter.md](references/runtime-adapter.md)。

## 7. 边界

- 不使用 IKB 的领域 Agent 作为通用角色；IKB 未来只能作为一个 workload adapter。
- 不通过 CLI 另起一套 Codex/Claude Runtime。
- 默认不引入 Opik 作为状态真源；Opik 只记录节点耗时、token、状态和验证信号。
- 任务状态、产物和 Handoff 以任务目录为真源；自然语言总结只是展示层。
