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
    → barrier 汇总 → 主 Agent 验收
    → 仅在必要时追加一个独立 verifier
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
- 普通节点创建时必须传入真实 `known_facts` 和 `evidence_refs`，两者都至少一项，不接受 TODO/TBD/待补占位符。`native-plan-step` 保持宽松兼容。
- `scope`、`read_scope`、`write_scope` 的一个数组元素只表示一个 scope。CLI 按空白、逗号、等号、分号和竖线识别 Unix/Windows 绝对路径，拒绝一个元素内拼接多个 scope；历史 task-dir 仍按原合同读取。
- 写入冲突使用 canonical path，不把含 `.`、`..`、重复分隔符或根路径别名的范围误判成可并行。

审查与独立验证规则：

- 默认不创建 reviewer 节点。主 Agent 负责运行机械验收、测试和已有 Eval Plane；这些证据足够时直接收口。
- 只有用户明确要求独立审查，或高风险语义判断无法由确定性检查覆盖时，才创建 verifier；一次任务最多一个独立 verifier。
- 不得并行创建“双 Agent review”，也不得按 Runtime、Eval Plane 或其他实现模块各起一个 reviewer。确需多领域调查时，把它们放在实施前作为普通调查节点，最终仍由主 Agent 统一验收。
- verifier 发现问题后，创建有边界的修复节点；如仍需复核，由原 verifier 最多复核一次。不得自动展开 `review → fix → 新 reviewer` 的开放式循环。

## 4. SpawnContract：主 Agent 发给子 Agent 的内容

子 Agent prompt 只注入任务所需上下文，不塞完整会话记录：

```markdown
## ContextPack
- task_schema/task_created_at: 任务合同版本和创建时间
- task_id/run_id: 任务与运行身份
- objective: 当前总目标
- task_runtime: task 创建时的 runtime
- scope: 本节点允许读取/修改的范围
- task_acceptance: 任务级验收条件
- task_allowed_side_effects: 任务级副作用范围
- budget: max_agents/max_retries
- known_facts: 已确认事实
- decisions: 已做决策
- open_questions: 尚未确定的问题
- evidence_refs: 文件、行号、链接或命令结果
- constraints: 技术、时间、权限和副作用限制

## SpawnContract
- goal: 本节点唯一目标
- depends_on: 前置节点
- post_conditions: 完成后必须成立的条件
- acceptance: 主 Agent 可以机械检查的条件
- output_contract: 必须生成的文件或结构化结果
- node_allowed_side_effects: 节点级副作用范围
- forbidden: 不得执行的动作

## 执行要求
独立判断，不预设主 Agent 的结论；不要读取兄弟节点的结果；遇到阻塞返回结构化 blocked Handoff。
```

`ContextPack` 应保留事实、证据和约束，删除无关历史、主 Agent 的猜测和兄弟节点结论。详细字段见 [contracts.md](references/contracts.md)。

CLI 创建普通节点时，用重复的 `--known-fact` 和 `--evidence-ref` 传入上述事实与证据。`--decision`、`--open-question`、`--constraint` 是可选字段，也会同时写入 `plan.json` 和 `nodes/<id>/input.md`；未传 constraint 时保留“遵守 task.json 和节点 allowed_side_effects”通用约束。脚本不会生成“待主 Agent 补充”一类占位内容。

## 5. Handoff 与验收

子 Agent 返回或写入：

```json
{
  "task_id": "booking-analysis",
  "run_id": "run-booking-analysis",
  "node_id": "inspect-booking",
  "attempt": 1,
  "execution_id": "execution-...",
  "status": "completed|blocked|failed",
  "conclusion": "结论",
  "evidence": ["证据引用"],
  "artifacts": ["产物路径"],
  "validation": ["执行过的检查"],
  "risks": ["未知或风险"],
  "next_action": "下一步"
}
```

`evidence`、`artifacts`、`validation` 和 `risks` 的元素必须是非空字符串；对象、null 和空白字符串不能写入 Handoff。空数组只表示当前没有该类内容，是否满足质量门由 Eval 合同决定。

主 Agent 必须自己运行 acceptance；子 Agent 自报完成不等于完成。CLI 只校验 Handoff 结构、DAG、状态和产物存在性，不假装执行自然语言 acceptance。验收优先使用文件存在、JSON 字段、命令退出码、测试结果、diff 范围等机械条件。语义质量默认也由主 Agent 结合证据判断；只有命中上面的独立验证条件时才交给 verifier。

启用 verifier 时，它只接收产物、证据和验收标准，不接收 producer 的完整辩护文本；通过后才能把任务标记为 `verified/completed`。未启用 verifier 时，主 Agent 验收通过即可进入终态。

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
  --known-fact "入口服务已由 task 证据确认" \
  --evidence-ref "file://artifacts/entry-evidence.json" \
  --decision "复用现有入口" \
  --open-question "是否需要独立 verifier" \
  --constraint "不修改 repo-b" \
  --dispatch-reason context_reduction \
  --dispatch-reason evidence_separation \
  --post-condition "形成可引用的调用链结论" \
  --acceptance "handoff 中包含证据路径"

python3 .agents/skills/work-orchestrator/scripts/work_harness.py validate .agent-work/booking-analysis
python3 .agents/skills/work-orchestrator/scripts/work_harness.py next .agent-work/booking-analysis
python3 .agents/skills/work-orchestrator/scripts/work_harness.py start-node .agent-work/booking-analysis \
  --node-id inspect-booking \
  --executor-kind subagent \
  --runtime codex \
  --executor-id codex-agent-42 \
  --lease-seconds 900
python3 .agents/skills/work-orchestrator/scripts/work_harness.py heartbeat \
  .agent-work/booking-analysis --node-id inspect-booking \
  --execution-id <start-node 返回的 execution_id>
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

`start-node` 必须显式声明 `executor_kind=parent|subagent|team` 和实际 `runtime=codex|claude-code`；subagent/team 必须提供 `executor_id`，parent 可以不提供。每次启动生成 attempt-specific execution_id，同时写入事件、`run-state.json.executions` 和 `nodes/<id>/execution.json`。新执行的 heartbeat 必须携带该 id。

新执行的 Handoff 必须携带 task_id、run_id、node_id、attempt 和 execution_id。record-handoff 在任务锁内校验当前执行及 lease，拒绝旧 attempt、跨节点结果和过期 lease。run-state、execution descriptor、`node.started` 或 `node.handoff_recorded` 任一出现 execution_id 都锁定 managed 模式；任一 managed 投影缺失或错配必须拒绝。只有这些位置全无 execution_id 的历史 execution 才走 legacy 兼容分支。

lease 默认 900 秒，范围为 30～3600 秒。到期前用 `heartbeat` 续期；`check-stale` 只读，不抢占、不写事件；`recover-stale` 才会把 stale running 节点显式转为 failed 并追加 `node.stale_recovered`。之后只能在 `max_retries` 预算内重新 `start-node`，重启成功时会清理该节点旧的 `failed_node`/`blocked_node` 投影。历史 running task 没有 lease 时，使用：

```bash
python3 .agents/skills/work-orchestrator/scripts/work_harness.py check-stale \
  .agent-work/legacy-task --older-than-seconds 3600
python3 .agents/skills/work-orchestrator/scripts/work_harness.py recover-stale \
  .agent-work/legacy-task --node-id inspect-booking --older-than-seconds 3600
```

历史判断优先使用最后一次 `node.started`/`node.heartbeat`，再回退 `run-state.updated_at`。检测不自动修改旧 task-dir。

跨 plan、ContextPack、run-state、execution descriptor、Handoff、verification 和 events 的状态转换先写 `.transition-journal.json`。add-node 把 plan 节点和 `nodes/<id>/input.md` 放在同一 journal；目标快照和事件共用 transition_id，事件按该 id 幂等。写入中止后由下一次写操作补完。validate、next 和 check-stale 只读，持有同一共享锁快照；发现 pending journal 时直接报错。

通用领域评估由外部 Eval Plane 产出，Harness 只保存经校验的投影：

```bash
python3 .agents/skills/work-orchestrator/scripts/work_harness.py record-domain-evaluation \
  .agent-work/booking-analysis --file domain-evaluation.json
```

该命令原子写入 `domain-evaluation.json` 并追加 `domain_evaluation.recorded`。它与 TypeScript 消费端使用同一套 v1 校验：Suite/Grader 安全标识、result 与 hard gate 等价、metrics 禁止 null/嵌套/Prompt/输出/路径/URL/payload/approval payload，evidence 只接受安全 URI 或 `file://`。报告还要通过普通文件、symlink 防护和原始字节 SHA-256 校验。Harness 不解释 metrics，也不实现 L3 判定。

在 canonical IKB 总目录中，`verify` 调用同级 Eval Plane 的 `work-run-quality@v4`，输入合同固定为 `work-harness-run-subject.v4`。任务锁从 `task.verified` 一直持有到 evaluator 返回并写完对应 trigger；命令传入 `--verification-id`。Harness 用固定的 canonical v4 projector 在 evaluator 前后计算 current subjectHash，要求两次结果不变，并与 stdout、报告和 Eval 完成事件逐值一致；报告原始字节 SHA-256 必须等于完成事件 reportHash。grader 固定为 `deterministic-v1`，results 必须完整、唯一且只包含固定 7 个 case，并匹配 case→level 映射。Harness 从 L1 statuses 与 `work-run-domain-result.metrics.required` 重算 hard gate，从全部 statuses 重算 pass/partial/blocked，同时重算 levels 和完成事件 totalCases/passedCases/failedCases/reasonCodes。run、suite/version、evaluationKey、reportRef 和 canonical reportPath 一并对账，evaluationKey 按 `sha256(runId + "\n" + suiteId + "\n" + suiteVersion + "\n" + subjectHash + "\n" + graderVersion)` 独立计算。任一错配记录 `invalid_output`，不能写 completed trigger。这些绑定字段写入 trigger 事件和 verification bookkeeping。崩溃留下 pending verification 时，除原 verify resume 外的写命令全部 fail closed；resume 复用原 id。评估环境失败返回 2，pass verdict 被质量门阻断返回 3，已经落盘的 terminal status 不回写。

执行前先读 [contracts.md](references/contracts.md)；需要适配当前运行时的提示词和计划映射时读 [runtime-adapter.md](references/runtime-adapter.md)。

## 7. 边界

- 不使用 IKB 的领域 Agent 作为通用角色；IKB 未来只能作为一个 workload adapter。
- 不通过 CLI 另起一套 Codex/Claude Runtime。
- 默认不引入 Opik 作为状态真源；Opik 只记录节点耗时、token、状态和验证信号。
- 任务状态、产物和 Handoff 以任务目录为真源；自然语言总结只是展示层。
