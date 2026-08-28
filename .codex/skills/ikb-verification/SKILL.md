---
name: ikb-verification
description: 验收 ikb 的 Knowledge draft、人物观察和任务产物是否有足够的来源、边界与真实验证证据。用户要求验证知识、确认 draft、检查任务是否真的跑通、或需要决定 pass/partial/blocked 时使用；只读审计，不代替生产操作，也不自动升级 verified。
---

# IKB 验收审计

把“来源存在”“用户确认”“真实 Task 验证”“已上线事实”分开。`lint`/`doctor` 只能证明结构和完整性，不能单独证明语义正确。

## 工作顺序

1. 读取 Task 的目标、验收条件、scope、时间范围和 Run checkpoint；确认审计问题具体是什么。
2. 读取待验收 Knowledge 或 Artifact 的全文及 frontmatter。若是人物卡，额外检查身份置信度、独立 Episode 数和观察边界。
3. 对每条主张逐项回到 `source_refs`：用 `./bin/ikb source context <source-id> --limit <n>` 读取原始记录；文档快照引用本地行号只作导航，Source record 才是证据。
4. 逐项判定：
   - `source_consistent`：主张与 Source 一致，且没有把计划/推断写成事实；
   - `scope_bounded`：适用范围、时间状态、未知和敏感边界明确；
   - `actionable`：存在具体任务、判断或步骤会使用它；
   - `user_confirmed`：用户明确确认了哪些编号；未回答的编号不能视为确认；
   - `task_validated`：有真实 Task、测试、演练、代码/配置/发布或工单结果；仅有设计文档不算；
   - `conflict_free`：没有更晚或独立 Source 与它冲突，或冲突已显式记录。
5. 把结果定为：
   - `pass`：所有必需检查通过，且验收条件要求的真实证据存在；
   - `partial`：来源和边界通过，但真实 Task/演练/当前状态证据仍缺失；Knowledge 必须保持 draft；
   - `blocked`：来源不能支持主张、身份无法确认、出现未解决冲突、越过权限/敏感边界，或验收条件明确失败。
6. 输出审计 Artifact，列出每项证据和下一步。不要直接 `knowledge verify`、不要覆盖旧卡、不要修改 Source、不要执行外部写操作。

## 必须明确的确认项

如果 Knowledge 正文含有 `待确认`，逐条记录 `confirmed`、`pending` 或 `deferred`。不能把“用户回复 123”解释成所有问题都确认；按交付顺序映射编号。用户确认也不等于真实 Task 验证：最多把相应检查记为 `user_confirmed`，生命周期仍可保持 `draft`。

## 人物审计边界

人物 dossier 是可重建 Evidence view，不是事实。只有精确身份匹配、至少两个独立 Episode、可行动的工作观察和明确时间范围才可 `partial/pass`；群参与、被 @、消息数量、人格/动机推断必须 `blocked` 或降为 unknown。用户说“暂不”时不修改人物卡、不升级置信度。

## 输出模板

```yaml
kind: verification
status: complete
task_id: <task-id>
run_id: <run-id>
result: pass|partial|blocked
knowledge_refs: []
evidence_refs: []
checks:
  source_consistent: pass|fail|unknown
  scope_bounded: pass|fail|unknown
  actionable: pass|fail|unknown
  user_confirmed: pass|partial|deferred|not_applicable
  task_validated: pass|partial|not_run
  conflict_free: pass|fail|unknown
claim_results:
  - claim: ""
    status: pass|partial|blocked
    evidence_refs: []
    reason: ""
confirmed_items: []
pending_items: []
next_action: ""
side_effects: none
```

## 常用命令

```bash
./bin/ikb show <task-id>
./bin/ikb knowledge show <knowledge-id>
./bin/ikb source context <source-id> --limit 20
./bin/ikb knowledge lint --scope work --json
./bin/ikb doctor --write-summary --compact --json
```

验证结果必须写入 Run Artifact 并关联 Source/Knowledge refs，但 Artifact 只保存 `health` 或紧凑计数/结论，禁止写入完整 `doctor`、`people rebuild` 或 `source ingest` JSON。只有在真实验收证据齐全且用户允许时，才由后续策展步骤决定是否升级；本 Skill 本身不改变 Knowledge 生命周期。
