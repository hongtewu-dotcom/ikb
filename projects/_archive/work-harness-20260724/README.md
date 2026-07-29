# Work Harness

Work Harness 是 IKB 总目录下的独立编排子项目。它复用 Codex 或 Claude Code 的原生 Plan 和子 Agent，只负责持久化任务目录、ContextPack、Handoff、DAG、恢复、验收和副作用门禁，不启动另一套 Agent Runtime。

## 运行合同

- 普通节点创建时必须显式传入至少一条 known fact 和 evidence ref；native-plan-step 仍可作为宽松的原生计划投影。生成的 input.md 不写待补占位符。
- init 的 scope、add-node 的 read_scope/write_scope 每个参数只表示一个 scope。新写入按空白、逗号、等号、分号和竖线识别 Unix/Windows 绝对路径，不接受一个值拼接多个 scope。旧 task-dir 仍可读取。
- write_scope 冲突按 canonical path 判断，会消除 `.`、`..`、重复分隔符并正确处理 Unix/Windows 根路径；原始值仍保留在 plan 中。
- start-node 必须声明 executor_kind 和实际 runtime；subagent/team 还必须声明 executor_id。每次启动生成新的 execution_id，写入 run-state、`nodes/<id>/execution.json` 和事件。
- lease 默认 900 秒，允许 30～3600 秒。新执行调用 heartbeat 时必须携带当前 execution_id；check-stale 只读；recover-stale 是唯一 stale 状态恢复入口。
- 默认不创建 reviewer 节点，也不得并行创建“双 Agent review”。主 Agent 先运行测试、机械验收和已有 Eval Plane；只有用户明确要求或高风险语义无法由确定性检查覆盖时，才增加最多一个独立 verifier。

历史 running task 没有 lease 时，check-stale 只有在传入 --older-than-seconds 后才会判断：优先读取该节点最后一次 node.started/node.heartbeat，找不到时回退 run-state.updated_at。检测不会补字段、写事件或改状态。

新执行的 Handoff 必须包含 task_id、run_id、node_id、attempt 和 execution_id。record-handoff 在锁内对账身份与 lease，旧 attempt、旧 heartbeat、跨节点结果和过期 lease 都会被拒绝。run-state、execution descriptor、`node.started` 或 `node.handoff_recorded` 任一带有 execution_id，该节点就必须按 managed 合同校验，字段缺失或错配不能降级；只有四处都没有 managed 身份证据的历史执行才走 legacy 兼容分支。

add-node、start、heartbeat、recover-stale、record-handoff 和 verify 使用 `.transition-journal.json` 完成跨文件状态转换。node.add 的 plan 节点与 `nodes/<id>/input.md` ContextPack 属于同一 transition。journal 自身原子写，事件按 transition_id 幂等；进程在写入边界中止后，下一次写操作会确定性补完。validate、next、check-stale 只读，发现 pending journal 会报错，不把 torn snapshot 当作正常状态。

## 常用命令

```bash
python3 scripts/work_harness.py add-node <task-dir> \
  --node-id inspect \
  --goal "检查调用链" \
  --read-scope "/repo-a/src" \
  --read-scope "/repo-b/src" \
  --known-fact "入口由现有 Thrift 服务提供" \
  --evidence-ref "file://artifacts/entry-evidence.json" \
  --decision "复用现有入口，不新增旁路" \
  --open-question "是否需要独立 verifier" \
  --constraint "不得修改 repo-b" \
  --post-condition "形成调用链结论" \
  --acceptance "handoff 包含源码引用" \
  --dispatch-reason independent_verification

python3 scripts/work_harness.py start-node <task-dir> \
  --node-id inspect \
  --executor-kind subagent \
  --runtime codex \
  --executor-id codex-agent-42 \
  --lease-seconds 900

python3 scripts/work_harness.py heartbeat <task-dir> \
  --node-id inspect \
  --execution-id <start-node 返回的 execution_id>
python3 scripts/work_harness.py check-stale <task-dir>
python3 scripts/work_harness.py check-stale <legacy-task-dir> --older-than-seconds 3600
python3 scripts/work_harness.py recover-stale <task-dir> --node-id inspect
```

## 领域评估投影

Eval Plane 或其他领域评估节点完成通用评估后，通过下面的命令写入 task-dir/domain-evaluation.json：

```bash
python3 scripts/work_harness.py record-domain-evaluation <task-dir> \
  --file /path/to/domain-evaluation.json
```

命令校验 v1 snake_case 合同、task_id/run_id、Suite/Grader 安全版本、严格日历与时区边界的 evaluated_at、安全 scalar metrics、evidence refs，以及 report_ref 指向文件的原始字节 SHA-256。metrics 不允许 null、嵌套值、prompt/output/path/url/payload 或 approval payload 类字段；字符串不能是空值、URL 或路径。result=pass 与 hard_gate_passed=true 必须等价。file:// 相对路径基于 task-dir；绝对路径可用；目标必须是普通非 symlink 文件。投影采用原子替换并追加 domain_evaluation.recorded 事件。Harness 只校验消费合同，不解释指标，也不做 L3 判定。

完整字段见 [references/contracts.md](references/contracts.md)。

## 目录

```text
work-harness/
├── SKILL.md
├── agents/
├── references/
└── scripts/
```

项目级 Skill 发现路径 `.agents/skills/work-orchestrator` 是指向本目录的兼容链接；源码只维护这一份。

## 验证

```bash
python3 scripts/test_work_harness.py
```

运行产生的 `.agent-work/` 或 `ikb-data/work-harness/` 是任务状态和证据，不属于项目源码。

`verify` 调用同级 Eval Plane 的 `work-run-quality@v4`，输入合同是 `work-harness-run-subject.v4`。同一个 task 互斥窗口覆盖 `task.verified`、外部 evaluator 和对应 `evaluation.trigger_completed|skipped|failed`，V2 不能在 V1 evaluator 读取前改写任务。调用参数携带 `--verification-id`；Harness 在 evaluator 前后分别调用固定的 canonical v4 projector，subjectHash 必须保持不变，并与 stdout、报告和 Eval 完成事件逐值相等。v4 grader 固定为 `deterministic-v1`，报告必须恰好包含固定且唯一的 7 个 case，并匹配 L1/L2/L3 映射；levels、hard gate、pass/partial/blocked 以及完成事件的 total/passed/failed/reasonCodes 均从完整 results 重算。报告按原始字节计算 SHA-256，与完成事件的 reportHash 对账；run、suite/version、evaluationKey、reportRef 和 canonical reportPath 也必须一致。evaluationKey 固定为 `sha256(runId + "\n" + suiteId + "\n" + suiteVersion + "\n" + subjectHash + "\n" + graderVersion)`。任一错配按 `invalid_output` fail closed。崩溃留下 pending verification 时，其他写命令全部拒绝，只有 `verify` 可以复用原 id 恢复。评估质量态不改写 Work Harness 的 terminal status，pass verdict 被质量门阻断时命令返回 3。
