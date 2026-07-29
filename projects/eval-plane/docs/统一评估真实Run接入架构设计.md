# 统一评估真实 Run 接入架构设计

状态：v1 已落地；Work Harness 跨轮 L2 与通用 L3 投影于 2026-07-23 补齐
范围：IKB 本地真实 Run、统一 Eval Plane、Run Quality、Observability、Outer Loop
已落地范围：真实 Run 加载、8 Case Assessment、幂等 Coordinator、Artifact/Event 写回、终态触发、维护补偿和聚合指标

## 1. 结论

IKB 需要把当前两条独立链路接成一条闭环：

~~~text
真实 Run
  → 结构化事件 / Artifact
  → Real-Run Adapter
  → 统一 Eval Suite
  → Evaluation Artifact + Ledger Event
  → Run Quality / Observability
  → Outer Loop 改进候选
~~~

固定回归 Case 和真实 Run 评估不能混为一谈：

- **Regression Suite** 验证评估规则本身是否正确，输入是合成 fixture 或固定事件样本。
- **Run Assessment** 判断某个真实 Run 是否满足协议、质量和领域约束，输入是该 Run 的真实 Ledger 事件与 Artifact 引用。

两者复用同一套契约、规则和 Grader，但输入源、结果语义和触发方式不同。

## 2. 当前边界

### 2.1 已有能力

| 能力 | 当前实现 |
|---|---|
| 真实 Run | LedgerStore 持有 Task、Run、Artifact 和事件链 |
| 结构化事件 | harness-events.v1，只允许状态、引用、计数和 hash |
| 质量投影 | run-quality.ts 从真实 Run 事件计算 terminal、Verifier、Evaluation、Gate、Artifact 和 quality state |
| 统一评估契约 | EvalSuite、EvalCase、EvalResult、EvalReport |
| 回归评估 | 旧 12 Case 和 Work/SpecX/Pipeline fixture Suite |
| 评估写回 | run.evaluation_completed，日报、Observability 和 Outer Loop 已有消费入口 |

### 2.2 已落地接线

真实 Run 的显式入口为：

~~~text
ikb run evaluate <run-id> --suite ikb-run-quality
ikb harness eval --suite ikb-run-quality --run <run-id>
~~~

`RunSubjectLoader` 会读取目标 Run 的事件、Artifact、Approval、Task 和 Plan，并过滤该 Run 已有的评估产物后生成稳定 `subjectHash`。Coordinator 使用 Run、Suite、Subject 和 Grader 版本生成 `evaluationKey`；相同键直接复用既有报告。

当前执行链已经是：

~~~text
指定 Run → RunSubjectLoader → Real-Run Adapter → EvalRunner
        → evaluation_report Artifact → run.evaluation_completed
~~~

固定 Case 仍走独立的 Regression Suite：

~~~text
fixture → Regression Suite → EvalRunner → 回归报告
~~~

两类 Suite 在 `EvalSuite.kind` 上显式区分；Regression Suite 不允许再通过 `--run` 冒充真实 Run 评估。

## 3. 设计目标与非目标

### 3.1 目标

1. 一个真实 Run 只有一个可追溯的评估入口，结果可以从 Ledger 重建。
2. 评估逻辑与执行逻辑分离；评估器只读，不修改 Run、Task、Knowledge 或外部系统。
3. L1 协议和安全问题可以硬阻断，L2/L3 作为过程和领域指标。
4. 重复评估幂等，同一 Run、Suite、版本和输入快照不会产生不可解释的重复结论。
5. 评估产物可以被 Run Quality、日报、Outer Loop 和人工复盘复用。
6. 保留当前 fixture 回归，不因接入真实 Run 破坏已有 12 Case。

### 3.2 非目标

- 不把所有指标压成一个总分。
- 不让 LLM Judge 直接改变 L1 门禁。
- 不把 Prompt、模型输出、原始工具 payload 或本地路径写入 Evaluation Event。
- 不让评估器自动修改 Prompt、Skill、角色、权限或 Knowledge。
- 不在 LedgerStore 内部嵌入评估器，避免真相源和派生逻辑互相依赖。

## 4. 总体架构

~~~mermaid
flowchart LR
    EXEC["Harness / Skill 执行"]
    STORE["LedgerStore\nTask / Run / Artifact / Event"]
    LOADER["RunSubjectLoader\n加载真实 Run"]
    ADAPTER["Real-Run Adapter\nIKB / Work / SpecX / Pipeline"]
    REG["EvalRegistry\nSuite / Case / Version"]
    RUNNER["EvalRunner\n确定性 Grader"]
    REPORT["Evaluation Artifact\n完整 Case 结果"]
    EVENT["run.evaluation_completed\n摘要 + 引用"]
    QUALITY["Run Quality Projection\n终态与质量分离"]
    OBS["Daily / Weekly Observability"]
    OUTER["Outer Loop\n失败聚类与候选"]
    HUMAN["人工 Review / Verifier"]

    EXEC --> STORE
    STORE --> LOADER
    LOADER --> ADAPTER
    REG --> RUNNER
    ADAPTER --> RUNNER
    RUNNER --> REPORT
    REPORT --> STORE
    STORE --> EVENT
    EVENT --> QUALITY
    EVENT --> OBS
    EVENT --> OUTER
    OUTER --> HUMAN
    HUMAN --> REG
~~~

### 4.1 模块职责

| 模块 | 职责 | 不负责 |
|---|---|---|
| LedgerStore | 保存 Run、Artifact、事件和状态投影 | 不执行评估 |
| RunSubjectLoader | 按 Run ID 读取事件、Artifact 元数据和安全输入 | 不解释业务语义 |
| Real-Run Adapter | 将真实输入归一化成 Eval Subject，执行领域检查 | 不写 Ledger |
| EvalRegistry | 管理 Suite、Case、版本和阈值 | 不读取真实文件 |
| EvalRunner | 调度 Case、汇总 L1/L2/L3、生成 Report | 不触发外部副作用 |
| EvaluationCoordinator | 处理触发、幂等、Artifact 注册和事件写回 | 不实现 Case 规则 |
| Run Quality | 从 Ledger 投影终态与质量态 | 不替代完整 Eval Report |
| Observability | 周期聚合指标 | 不修改评估结论 |
| Outer Loop | 聚类重复失败，生成待审候选 | 不自动改规则 |

## 5. 真实 Run 输入模型

Real-Run Adapter 读取以下信息：

~~~text
Run
  ├─ taskId / agentId / skillIds / retryOf / status / startedAt / finishedAt
  ├─ Run aggregate 的结构化 Harness Events
  ├─ Run 关联的 Artifact 元数据
  ├─ runDir/plan.json 等已登记的本地产物
  └─ Task 的类型、scope 和 acceptance 元数据
~~~

输入分三类：

| 输入 | 读取方式 | 是否进入 EvalResult |
|---|---|---|
| 事件状态、版本、引用、hash | Ledger Event | 允许以结构化字段或引用进入 |
| Artifact 内容 | 通过 Artifact Ledger 元数据定位后读取 | 只输出摘要指标和 artifact:// 引用 |
| Prompt、模型输出、原始工具内容 | 不作为评估输入持久化 | 不进入 EvalResult/Event |

RunSubject 建议形态：

~~~typescript
interface RunSubject {
  subjectVersion: string;
  runId: string;
  run: RunMetadata;
  events: StructuredRunEvent[];
  artifacts: RunArtifactRef[];
  task: TaskMetadata;
  sourceRefs: string[];
  artifactRefs: string[];
  subjectHash: string;
}
~~~

RunSubject 是内存中的评估输入。持久化时只保存 subjectVersion、subjectHash、事件引用、Artifact 引用和标量指标。

## 6. Suite 设计

统一 Eval Plane 保留三类 Suite。

### 6.1 Regression Suite

用途：验证规则和 Grader 没有回归。

输入：合成事件、fixture、固定知识准入样本。
触发：开发、版本变更、CI 或手工回归。
结果语义：status=pass 表示 Grader 对该固定样本判断正确。

当前 12 Case 继续保留，不迁移、不删除。

### 6.2 Run Assessment Suite

用途：评估某个真实 Run。

输入：RunSubject。
触发：Run 终态后自动触发，或显式执行 run evaluate。
结果语义：status=pass 表示该 Run 满足对应质量不变量。

建议首批 Case：

| Case | 层级 | 真实 Run 检查 |
|---|---|---|
| run-quality-chain | L1 | 成功 Run 是否有 Step、通过 Gate、Verifier 和 Artifact |
| run-terminal-is-not-quality | L1 | terminal succeeded 但证据链不完整时必须判为质量失败 |
| run-handoff-contract | L1 | Handoff 的来源、目标和输出引用完整 |
| run-dag-contract | L1 | Plan 依赖存在且无非法环 |
| run-approval-binding | L1 | Approval 与 Action 的目标/载荷 hash 匹配 |
| run-side-effect-idempotency | L1 | 同一 Action 身份不能产生冲突副作用 |
| run-recovery-quality | L2 | 重试次数、修复轮次、首次通过和最终通过 |
| run-domain-result | L3 | 按 Task 类型调用 IKB/SpecX/Pipeline 领域 Adapter |

### 6.3 Period Assessment Suite

用途：评估跨 Run 的趋势和反馈闭环。

输入：一个日报或周报窗口内的 Run 摘要、失败观察和 Knowledge feedback。
典型检查：

- evaluation coverage 是否达标；
- quality pass rate 是否改善；
- 重复失败是否形成稳定模式；
- Outer 候选是否经过独立验证；
- Knowledge 的 helpful/partial/incorrect 是否有变化。

Outer Loop 不应作为单个 Run 的 L1 Case，它需要多个独立 Run 才有统计意义。

## 7. 评估执行时序

~~~mermaid
sequenceDiagram
    participant H as Harness
    participant S as LedgerStore
    participant C as EvaluationCoordinator
    participant L as RunSubjectLoader
    participant R as EvalRunner
    participant A as Artifact Ledger
    participant O as Observability/Outer

    H->>S: 写入 step/gate/verifier/action 事件
    H->>S: finish Run
    C->>S: 读取 Run 与已有 evaluation 事件
    C->>L: load(runId)
    L->>S: 读取 Run Events / Artifacts / Task
    L-->>C: RunSubject + subjectHash
    C->>R: run assessment suite
    R-->>C: EvalReport
    C->>A: 注册 evaluation report Artifact
    C->>S: 写 run.artifact_linked
    C->>S: 写 run.evaluation_completed
    S-->>O: 日报、质量投影、Outer Loop读取
~~~

### 7.1 触发策略

采用“显式入口 + 有界自动触发 + 可恢复扫描”：

~~~text
run finish
  → coordinator 尝试评估
  → 评估失败只记录 environment/grader failure
  → 不改变 Run terminal 状态

maintenance daily
  → 扫描 terminal Run 中缺失或过期的 evaluation
  → 重新执行有界评估
~~~

不把评估逻辑放入 LedgerStore.finishRun。LedgerStore 只负责写入终态；Coordinator 位于 CLI/运行时控制层，负责在状态写入后调用评估。

建议命令：

~~~bash
./bin/ikb run evaluate <run-id> --suite ikb-run-quality --json
./bin/ikb harness report --run <run-id> --suite ikb-run-quality --json
./bin/ikb maintenance --repair-evaluations --json
~~~

## 8. 结果与写回契约

### 8.1 Evaluation Artifact

完整结果写入：

~~~text
ikb-data/evaluations/<suite-id>/<run-id>-<evaluation-key>.json
~~~

同时通过 LedgerStore.createArtifact 注册为 Artifact，类型建议为：

~~~text
kind = evaluation_report
label = <suite-id>@<suite-version>
~~~

然后追加：

~~~text
run.artifact_linked
  relation = produced
  lineageRefs = [run://<run-id>]
~~~

这样 artifactLinkCount 和 Evaluation Artifact 都进入同一条 Ledger 链，不只在事件里写一个未注册的 artifact:// 字符串。

### 8.2 run.evaluation_completed

事件只保存摘要：

~~~json
{
  "evalVersion": "eval-plane.v1",
  "suiteId": "ikb-run-quality",
  "suiteVersion": "v1",
  "graderVersion": "deterministic-v1",
  "subjectVersion": "ikb-run-subject.v1",
  "subjectHash": "sha256:...",
  "result": "pass",
  "totalCases": 8,
  "passedCases": 8,
  "failedCases": 0,
  "failedCaseRefs": [],
  "reasonCodes": [],
  "artifactRefs": ["artifact://..."]
}
~~~

需要新增的字段必须先进入 harness-events.ts 的允许字段和校验逻辑。事件不保存完整 EvalResult。

### 8.3 幂等键

~~~text
evaluationKey =
sha256(runId + suiteId + suiteVersion + subjectHash + graderVersion)
~~~

重复执行同一键时：

- 已有相同通过结果：返回既有结果，不重复写 Artifact；
- 已有相同失败结果：允许显式 force 生成新版本，但必须改变 evaluationKey 或 Grader 版本；
- Subject hash 变化：视为新的评估输入，追加新的 Evaluation Artifact。

Work Run 当前以 `work-run-quality@v4` 和 `work-harness-run-subject.v4` 作为 verification identity、terminal trigger 缓存、stale recovery 区间、managed Handoff 与 UNC scope 完整性的缓存边界。旧 v1/v2/v3 报告和事件索引保留审计，但 Coordinator 必须计算新的 v4 `evaluationKey`，不能复用旧报告。

## 9. L1/L2/L3 规则边界

### L1：必须由代码判定

- 事件 schema 和引用合法；
- Run 状态与终态事件一致；
- Plan/DAG 依赖存在；
- Handoff 完整；
- Verifier、Gate、Artifact 链存在；
- Approval 与 Action 的目标/载荷 hash 匹配；
- Action 身份幂等，无冲突副作用；
- scope 不越界。

Work Run 的 `native-plan-step` 缺省 scope 投影为空数组，字段存在时仍严格校验。并发 scope 比较按 POSIX/Windows lexical canonical path 处理点段、重复分隔符和根范围；历史 bundled UNC 在 task/read/write 三类 scope 中都产生字段级 reason。`node.stale_recovered` 关闭旧 attempt 的 active 写区间。managed execution 联合 run-state、execution descriptor 与一次解析得到的 started/handoff 主事件判定；任一来源含 `execution_id` 都禁止降级，并把 descriptor/event/Handoff 五字段冲突变成稳定 reason code和 L1/closure 阻断，只有全部来源无 ID 才兼容 legacy。Handoff 四个数组只接受非空字符串。领域报告通过 `O_NOFOLLOW` 打开，并在同一 fd 上完成 `fstat`、读取和 hash。

L1 失败时，hardGatePassed=false，但仍可继续收集其他 Case 结果，方便定位多个问题。

### L2：评估过程质量

- firstPass；
- finalPass；
- repairRounds；
- retryRounds 与预算；
- manualIntervention；
- 并行波次利用率；
- 重复失败原因。

L2 不覆盖 L1 的安全结论，也不把重试后的成功解释成首轮成功。

新 `task.verified` 与 `evaluation.trigger_*` 通过 `verification_id` 精确配对，历史无 id 事件按 FIFO 兼容。attempt 通过要求 verification verdict、L1/common closure 和整体结果均通过；optional L3 partial 也不算 final pass。Work Harness 的 `retryRounds` 仅来自节点 attempts，是独立指标，不参与 `firstPass` 或 `recoverySucceeded`；`repairRounds` 只统计未通过的质量 attempt。前一轮 blocked、当前轮 pass 时，报告必须保留 `firstPass=false`、`repairRounds>=1` 和 `recoverySucceeded=true`。

v4 `subjectHash` 与 L2 共用 pending-attempt 单遍状态机：每个 `task.verified` 建 pending，identified terminal trigger 只在到达时消费同 id 队列；early/unmatched 与已消费后的重复或冲突终态同时被 L2 和 hash 忽略，冲突保持 first-wins。匹配摘要按 verification attempt 顺序投影，所以 T2,T1 与 T1,T2 等价；不做全局摘要去重，同 id 的两个真实 attempt 即使得到相同摘要也各自保留。legacy 无 id trigger 继续 FIFO，并在语义时间线中保留物理阶段。摘要只保留 event、verification identity、result、hard gate、reason 与必要的 run/Suite identity，排除时间、evaluationKey、reportRef、reused 和 verification document bookkeeping；晚到且匹配的 trigger 推进一次 key，随后稳定复用。Work Harness 调用 `work-eval-cli --verification-id <id>` 时，Coordinator 在每次 Subject load/reload 都把该 id 与 verification document 及最新 `task.verified` 对账，并在输出回传 verificationId、subjectHash、subjectVersion、suiteVersion；直接 IKB eval 不带该参数时保持兼容。

缓存命中与新评估路径在返回前都执行 bound Subject final reload，对账 verification identity、subject version/hash 和派生 key。变化时旧轮不形成成功返回，最多重新绑定三次；新建中间报告只有 final reload 通过后才能获得完成事件，失配时按原始字节 hash 清理，既有无事件文件保持未索引隔离。final reload 是结果快照的线性化点，per-key 锁保证并发同 key 只有一个发布者；Work Harness 外层 task lock 继续覆盖该点到 stdout 校验和 trigger 落盘，消除受支持 mutator 的残余窗口。绕过锁的直接文件写入无法由 Eval Plane 单方禁止，只能作为线性化点之后的新快照在后续 key 中体现。

Eval Plane 新写入的 `evaluation.completed` 必须显式携带 `hardGatePassed`，并与 result 和报告重算值一致；历史缺字段事件仍按 result 映射读取。显式字段存在但类型错误或与 result/report 冲突时 fail closed，不能命中缓存或驱动 Work Harness 放行。

### L3：领域结果

- IKB：准入契约、证据强度、scope、Knowledge feedback；
- SpecX：AC 覆盖率、产物完整性、代码/测试一致性、新鲜度；
- Pipeline：CaseSpec、步骤一致性、断言有效率、日志验证命中、清理幂等；
- Work Harness：节点合同、Handoff、并行写范围和执行摘要。

Work Harness 通过 task-dir 下的 `domain-evaluation.json` 接入任意领域 Suite。合同版本固定为 `work-harness-domain-evaluation-v1`，字段统一使用 snake_case，绑定 `task_id/run_id`、Suite/Grader 版本、required、领域结果、报告 `file://` 引用与原始字节 SHA-256、标量 metrics 和 evidence。报告必须是普通非 symlink 文件；身份、文件或 hash 不一致按 subject failure 阻断。未注册仍返回 `not_applicable`；required 领域失败同时令 Eval Report 的 `hardGatePassed=false`。

## 10. 指标口径

回归评估和真实 Run 评估必须分开统计。

| 指标 | 口径 |
|---|---|
| evaluation_coverage | 已完成评估的终态 Run / 全部终态 Run |
| quality_pass_rate | qualityState=pass 的 Run / 已评估 Run |
| guardrail_correctness | 回归 Case 中 Grader 判断正确的 Case / 全部回归 Case |
| first_pass_rate | 首轮通过的真实 Run / 有执行结果的真实 Run |
| final_pass_rate | 最终通过的真实 Run / 有执行结果的真实 Run |
| recovery_success_rate | 重试后最终通过的 Run / 发生重试的 Run |
| repeat_failure_rate | 出现重复失败模式的 Run / 已评估 Run |
| knowledge_useful_rate | helpful / (helpful + partial + incorrect) |
| side_effect_conflict_rate | 副作用身份冲突 Action / 有副作用 Action |

负向回归 Case 的 pass 只表示“正确阻断”，不能混入真实任务成功率。

Suite 的阈值必须由 EvalSuite.thresholds 驱动，不能由 Adapter 继续硬编码。每个可聚合指标还需要明确：

~~~text
metricId / unit / numerator / denominator / direction / threshold
~~~

## 11. 失败诊断与反馈

评估失败要区分四类：

| diagnosis | 含义 | 处理 |
|---|---|---|
| subject | Run 或产物违反契约 | 进入失败观察和回归候选 |
| grader | 评估规则实现异常 | 阻止自动升级，修 Grader |
| ground_truth | Case/期望本身不合理 | 人工修订 Suite |
| environment | Artifact 缺失、读取失败、运行环境异常 | 可重试，不归因给 Agent |

失败写回至少包含：

- failedCaseRefs；
- reasonCodes；
- diagnosis；
- Evaluation Artifact 引用；
- subjectHash 和 Suite/Grader 版本。

Outer Loop 读取 reasonCodes 进行聚类；相同 evaluation_incomplete 不应掩盖具体是 verifier_missing、write_scope_conflict 还是 approval_hash_mismatch。

Outer Loop 只生成：

~~~text
pending_review candidate
  + evidence event hashes
  + regression case ids
  + independent run count
  + validation plan
~~~

它不直接修改 Skill、Prompt、角色、权限或门禁。

## 12. 安全与数据边界

1. 真实 Run Adapter 只能读取当前 Task/Run scope 内的数据。
2. EvalResult、Harness Event 和日报不保存 Prompt、模型输出、原始路径、URL、人物身份和 Approval payload。
3. Artifact 的本地路径只保存在 Artifact Ledger 的内部记录，不写入公共评估事件。
4. 外部系统读取仍沿用现有只读和限频边界。
5. 评估本身不执行 Action，不发送消息，不修改外部系统。
6. 评估失败不能静默降级；必须有可查询的 environment 或 grader 结果。
7. Harness Event 的引用只能是受限 ref/token；标签必须单行、有长度上限，并拒绝 URL、本地路径、Prompt/原始输出形态。
8. Ledger hash chain 断裂属于 L1 subject failure；即使 payload 仍可解析，也不能产生质量通过结论。
9. 相同 evaluationKey 的并发请求必须有界等待并收敛到同一 Artifact/Event，不能把正常竞争暴露为调用失败。

## 13. 代码落点

建议新增或调整的模块：

~~~text
projects/eval-plane/src/
  eval-contract.ts          # Suite kind、Result/Report 和安全引用契约
  eval-registry.ts          # 注册 Regression / Assessment Suite
  eval-runner.ts            # 同时支持 fixture 与 RunSubject 输入
  eval-adapters.ts          # fixture Adapter 与真实 IKB Run Adapter
  run-subject.ts            # Ledger → RunSubject + subjectHash
  run-assessment.ts         # IKB 真实 Run 8 Case
  evaluation-coordinator.ts # 触发、幂等、Artifact、事件写回、补偿扫描
~~~

现有模块的边界：

- store.ts 继续只负责 Ledger 真相源；
- run-quality.ts 继续负责轻量质量投影；
- observability.ts 继续负责周期聚合；
- outer-loop.ts 继续负责失败聚类；
- harness-eval.ts 继续兼容旧 12 Case。

## 14. 分阶段落地

### Phase 1：真实 Run 可评估（已完成）

- 新增 RunSubjectLoader；
- 新增 ikb-run-quality Assessment Suite；
- run evaluate <run-id> 读取真实事件；
- 完整报告注册为 Artifact；
- 增加完整 Run、缺 Verifier、Approval 冲突、Artifact 缺失测试。

验收：同一真实 Run 的评估结果与 run-quality 投影一致；缺少质量链时不能得到 quality=pass。

### Phase 2：自动触发与恢复（已完成）

- Run 终态后由 Coordinator 自动评估；
- 日常维护扫描缺失/过期评估；
- 同一 evaluationKey 幂等；
- 评估失败可区分 subject、grader、environment。

验收：重复触发不产生重复结果；评估进程中断后可恢复；不改变 Run 的 terminal state。

### Phase 3：指标和反馈闭环（已完成基础接线）

- 阈值由 Suite 配置驱动；
- 补齐真实 Run 聚合指标；
- Evaluation Event 写回详细 reason code；
- Outer Loop 使用 Case 级失败原因；
- Knowledge useful rate 和候选验证率继续由 Knowledge/Outer 领域报表维护，不塞进单 Run Suite。

验收：日报能区分评估覆盖、质量通过、首轮通过、最终通过、恢复成功和重复失败。

### Phase 4：外部 Harness 接入（Work Harness 已完成通用合同，其他领域待接）

- Work Harness 读取真实 plan.json、run-state.json、事件和可选 `domain-evaluation.json`；
- SpecX 读取真实变更产物；
- Pipeline 读取 CaseSpec、断言和清理结果；
- 保留各领域 Adapter，不把业务判断塞进 IKB Core。

## 15. 验收清单

- [x] --run 真正读取目标 Run 的事件和 Artifact，而不只是关联 runId。
- [x] Regression Suite 与 Run Assessment Suite 分离。
- [x] L1 失败能阻断 quality pass。
- [x] terminal succeeded 但缺 Verifier/Artifact 时质量仍为 block。
- [x] 真实 Approval hash 不匹配时评估失败且不执行副作用。
- [x] Evaluation Report 注册为 Artifact，并有 run.artifact_linked。
- [x] 重复评估按 evaluationKey 幂等。
- [x] Work Harness blocked→pass 能保留跨轮修复指标；bookkeeping-only 评估写回不改变 subjectHash，匹配到 pending attempt 的终态只推进一次缓存代际。
- [x] Work Harness 通用领域报告绑定 task/run、Suite/Grader、普通文件和 SHA-256。
- [x] required 领域失败进入 hard gate；未注册领域结果保持 not_applicable。
- [x] Evaluation Event 只保存摘要、引用、hash 和标量指标。
- [x] 日报能统计真实 Run 的 evaluation coverage 和 quality pass rate。
- [x] Outer Loop 能按 Case reason code 聚类，并保持 pending_review。
- [x] 旧 12 Case 和现有 fixture 测试全部保持通过。

这份设计的落点不是新增一个孤立的评估服务，而是让 IKB 的真实 Run 成为统一评估的输入，让 Ledger 成为评估结果的唯一可追溯落点。
