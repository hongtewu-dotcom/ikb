---
name: ikb-maintain-knowledge
description: 持续维护 IKB 的本地证据、Experience、人物档案与 QV5 Knowledge。用于每日或每周语义维护、消费分析队列、处理知识反馈、重建人物档案、修订或合并现有知识，以及生成待确认评审包；不负责直接抓取学城或大象。
---

# IKB 持续知识维护

把已经进入 IKB 的本地证据持续加工成可检索、可直接使用、可回溯、可修订的知识。这个 Skill 负责语义判断；确定性的采集、去重、排队、索引、lint、doctor 和账本校验继续由仓库脚本负责。

## 不可违反的边界

1. 知识的目标是支持真实工作，不以“生成条数”作为成功标准。`admit`、`revise`、`merge`、`skip`、`evidence_only` 都是正常结果。
2. 只消费已经落入 `/Users/htwu/projects/_personal/ikb/ikb-data` 的本地 Source、Experience、反馈和 Artifact。不得在本流程中访问学城、大象或其他外部系统，不得发消息、评论或改外部文档。
3. 每次最多处理 3 个语义主题。一个主题可以有多条 Source，但必须形成一份冻结证据清单，避免按文件机械生成碎片知识。
4. Source、Experience、Knowledge、Artifact、Ledger 分层保存。原始证据不因生成 Knowledge 被删除；重复原始内容只能由确定性去重能力压缩，并保留来源关系。
5. 只有完整 QV5 产物和全部门禁通过后，才允许创建或替换 Knowledge。不得把一句摘要、文章目录、截图说明或未经验证的推断当作正式知识。
6. 不自动升级为 `verified` 或 `user_confirmed`。既有 `verified`、`user_confirmed` 知识也不得静默覆盖；只能生成评审包，等待人工确认。
7. 人物知识默认只做 `evidence_only` dossier。不得推断性格、动机、能力、绩效、晋升、权力关系或私人属性；扩大用途必须有足够独立证据并经人工确认。
8. 不提交、不推送代码，不修改其他项目，不产生外部副作用。

## 两层维护模型

### 确定性维护

本层由 `node scripts/ikb-maintenance.mjs daily|weekly` 执行，负责本地增量导入、去重、Experience triage、候选发现、人物证据重建、索引、lint、doctor、账本和报表。它可以整理和排队，但不能宣称已经完成语义知识编纂。

### 语义维护

本 Skill 消费确定性维护留下的本地队列和反馈，做证据编译、保真核对、冲突处理、知识生命周期维护和人工评审包生成。两层不得互相冒充。

## 每次运行

### 1. 建立可追溯运行

进入 `/Users/htwu/projects/_personal/ikb`，新建一个 Task 和 Run，计划至少包含：

`inspect-state -> select-subjects -> freeze-evidence -> compile -> verify -> apply-or-review -> close-gates`

把输入计划、冻结证据清单、编纂结果、验证报告、变更摘要都注册为 Artifact。Run 的 `succeeded` 只表示流程结束，不等于知识质量通过。

### 2. 检查基线

Task、Run 或 Artifact 事件会让上一次健康快照自然变旧。先刷新本地确定性摘要，再读取聚合健康状态；`stale` 本身不等于账本损坏，也不能靠反复读取 `health` 消除。

按以下固定顺序运行并保留结果：

```bash
./bin/ikb doctor --write-summary --compact --output json
./bin/ikb ledger verify --write-summary --output json
./bin/ikb health --output json
./bin/ikb knowledge lint --scope work --output json
./bin/ikb experience queue --output json
./bin/ikb people readiness --scope work --mode incremental --write --output json
```

刷新后若 `doctor`、`ledger` 或 `health` 仍不健康，先记录 `blocked`，不得在损坏账本或知识布局上继续写知识。

### 3. 选择最多 3 个主题

按以下顺序选择，排在前面的优先：

1. 使用反馈为 `incorrect` 或 `partial` 的既有 Knowledge；
2. 人工纠偏、Verifier 驳回、冲突或过期信号；
3. 人物 readiness 从积累期进入可分析期；
4. 有独立 Episode 或真实验证支持的高优先级 Experience；
5. 新进入本地 Source、且能回答明确工作问题的业务文档或评论。

若同一事实已经被现有 Knowledge 覆盖，优先 `no_change`、`merge` 或 `revise`，不要另造同义卡。没有合格主题时，以 `no_change` 正常结束。

### 4. 冻结证据

每个主题先生成证据 manifest，至少记录：

- 主题和要支持的真实任务；
- Source、Experience、Knowledge、反馈和 Artifact 引用；
- 原文范围或事实单元；
- 时间状态、作者/说话人身份和适用范围；
- 反例、冲突、未知项；
- 当前知识是否已覆盖，以及预计处置。

证据清单一旦进入编纂不得静默变化。发现缺证据时停止该主题，标记 `evidence_only` 或 `blocked`，不要靠常识补齐。

### 5. 按知识类型编纂

继续使用 `$ikb-knowledge-curator`，并遵循对应产品形态：

- 业务知识：保留领域对象、状态/规则、链路、边界、异常、实例、时间状态和来源定位；
- 工程知识：保留问题、触发条件、诊断路径、决策依据、操作步骤、验证方法、停止条件和失败分支；
- 写作或沟通知识：保留适用场景、输入、结构、表达策略、反例、检查表和可复用模板；
- 决策知识：保留背景、选项、取舍、结论、约束、后续动作和失效条件；
- 人物 dossier：按身份事实、公开职责、明确观点、沟通/写作样本、决策偏好观察、协作提示、反证和未知项分栏；每条观察必须能回到原始证据，不把观察写成定论。

知识正文必须能让未来 Agent 在不重读全部原文时完成目标任务，同时保留足够引用让它在高风险处回源。不能只写“是什么”，还必须写“何时用、需要什么输入、怎么做、怎样检查、何时停止、哪些情况不能用”。

### 6. QV5 验证

继续使用 `$ikb-verification`。每个主题至少产出：

1. extraction inventory；
2. 冻结 benchmark manifest；
3. 完整编纂结果；
4. extraction validate 报告；
5. extraction verify 报告；
6. product-view 正文；
7. 信息损耗/保真报告；
8. canonical key 与现有 Knowledge 唯一性检查。

硬门禁包括：关键事实有引用、重要限定与反例未丢失、没有来源外断言、正文可执行、使用契约完整、scope/时间状态/置信度明确、冲突已暴露、信息损耗在 manifest 允许范围内。任一硬门禁失败，不得写入正式 Knowledge。

### 7. 应用或生成评审包

- 新知识或 `draft/source_confirmed` 的安全修订：只有 QV5 全绿时才可事务化写入；
- `verified/user_confirmed`、人物用途扩展、政策性结论、高风险操作：只生成评审包；
- 重复、证据不足或没有复用价值：记录 `skip`、`evidence_only` 或 `no_change`，并写清原因。

### 7.1 P0 纠错隔离与 QV5 解锁

发现能直接否定既有 Knowledge 的 P0 反例时，先执行：

```bash
./bin/ikb knowledge correction-request <knowledge-id> --run <run-id> --artifact <artifact-id> --action <revise|retire> --reason "<可复核的纠错原因>"
```

`--artifact` 必须是同一 Run 已登记、完整且当前字节/hash 可校验的 Artifact；该 Run 所属 Task 的 scope 必须等于目标 Knowledge scope。相同目标、Run、Artifact、动作和原因幂等复用一个 `pending_review` correction Candidate；此命令绝不改动目标卡的正文、status 或 revision。`pending_review` 和 `accepted` 的 revise/retire Candidate 都自动形成 retrieval hold，默认 `search` 和 `context` 排除目标卡。

`verified/user_confirmed` 卡也只能生成完整评审包，等待人工确认，不能静默覆盖。完成替换稿的 QV5 revision 后，才可执行：

```bash
./bin/ikb knowledge qv5-resolve-hold <candidate-id> --revision <revision-id>
```

该命令仅在 Candidate 已 `accepted`、唯一目标和 scope 与 revision journal 一致、当前 reviewed Artifact hash 与 journal 导出的 replacement Artifact hash 一致、journal 已 `completed`，且当前卡字节仍等于 journal `afterHash` 时标记 `applied` 并解除 hold。任一条件不符必须 fail-closed，保留 hold，不让旧卡重新进入默认检索。

需要人确认时必须讲人话：先说“要决定什么”，再说“为什么现在必须决定”，列出推荐项、影响和可点击的完整稿/原始证据。不要只给 ID、状态枚举或抽象术语。

### 8. 穿过最终消费者

抽取门禁通过还不够。选一个真实的编码、评审、CR、写文档、规划或沟通任务，通过 `$ikb-use-knowledge` 检索并使用新知识，保存 Context Pack 和最终产物，再记录反馈。

只有发生真实使用，才可写 `helpful`、`partial`、`incorrect` 或 `unused`；单纯检索、维护或自检不能伪造 `helpful`。

### 9. 收口

先写完本 Run 的 Artifact、状态和账本事件，再按“`doctor --write-summary --compact` → `ledger verify --write-summary` → `health` → `knowledge lint`”顺序运行最终门禁及相关回归。关闭 Run 和 Task 会再次产生账本事件，因此终态关闭后必须再刷新一次摘要并确认 `health`。Artifact 只能保存 `health` 或各命令的紧凑摘要；不得写入完整 `doctor`、`people rebuild` 或 `source ingest` JSON。最终报告只允许四种状态：

- `changed`：知识已安全新增、修订或合并；
- `no_change`：检查完成，没有合格变更；
- `needs_review`：有完整评审包等待人工决定；
- `blocked`：证据或系统门禁不足。

报告必须给出处理主题、处置、Knowledge/Source/Artifact/Run 引用、门禁结果、待确认事项和下一次入口。不得用“处理了多少条队列”代替知识质量结论。

## 调度默认值

Codex 定时任务只运行本 Skill 的语义维护，默认每天一次、每次最多 3 个主题；确定性采集与整理仍由现有本地维护任务负责。两者都必须先有一次人工 canary 通过，失败时保留现场并停止后续写入。
