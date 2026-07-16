# ikb 路线图与验收

## 建设顺序

第一版不追求一次接管所有工作。顺序按依赖关系排：先建立本地工作账本，用它记录后续建设；再完成知识检索和执行 Harness；最后开放外部动作。界面不在关键路径上。

### M0：方案与边界

产出：主架构、对象契约、权限等级、数据分区、首批工作流和 Plan Pack 使用判定。

验收：知识、Task、Run 三类记录没有职责重叠；公开仓与真实 Vault 的边界明确；所有外部副作用都有审批归属。

### M1：本地工作账本

实现 Task、Run、Approval、Artifact、不可变 JSONL 事件账本和状态投影；提供 `list / show / timeline / follow / report` 等只读视图。CLI 是首版控制面，`events.jsonl` 是运行账本真相源，索引层后置。

首批 CLI：

```text
ikb init
ikb status
ikb task add|list|show|start|done
ikb run list|show|follow|resume|retry
ikb approval list|show|approve|reject
ikb artifact list|open|diff
ikb timeline
ikb report daily|weekly
ikb doctor
```

验收：创建和推进 Task 后能看到完整时间线；每次 Run 都能关联输入、日志、产物和 checkpoint；重启进程后状态不丢；所有当前状态都能从事件账本重建；从 M2 开始，ikb 自己的建设任务全部进入该账本。

### M2：Source Plane 与知识底座

实现 Source registry、原始快照、消息/文档/评论归一化、增量扫描、Markdown Vault、扁平 frontmatter、候选准入、统一 search、引用追踪和 doctor。首批输入包含重要文档、版本差异、CR/文档评论，以及本地历史 Agent 会话。

首批 CLI：

```text
ikb capture
ikb ingest
ikb search
ikb context
ikb review
```

验收：可以从脱敏材料生成 draft 知识；verified 必须有证据；文档草稿、版本差异和评论能回链到最终 Artifact；删除派生索引后能重建；personal/work 结果不会越界混用。

### M3：Harness 运行时

实现 Agent/Skill manifest、`ikb-source-intake`、`ikb-conversation-analysis`、`ikb-knowledge-curator`、context builder、固定步骤编排、质量检查、checkpoint、重试与 Action Gateway；先支持前台运行，再增加本地 daemon。Skill 作为 Agent 入口，CLI 只提供底层确定性能力。

验收：可以给 Task 选择 Agent/Skill 并启动 Run；运行能停在 awaiting_approval；失败后从 checkpoint 恢复；未声明的 Skill 和未经批准的外部动作无法执行。

### M4：低风险工作流

先接重要文档、写作、CR/文档评论和沟通草稿。这些输入能验证知识引用、写作偏好、评论沉淀、人工门禁和结果回写，又不会修改代码或外部系统。

验收：完成“创建 Task → 生成 context pack → 产出草稿 → 人工修改/接受 → 记录差异 → 形成知识候选”的闭环；连续真实使用两周后，统计接受率和主要修改原因。

### M5：编码、评审与 CR

接入 Git worktree、代码搜索、GitNexus、构建测试和 reviewer；实现编码、评审和 CR 三个 Agent。

验收：编码 Run 有隔离工作区、测试和 diff；评审结论带文件/行号与证据；CR 外部评论和 push 无法绕过人工批准；失败 Run 可以从 checkpoint 恢复。

### M6：外部系统

按需接入 ONES、学城、大象、日历和远程 Agent runtime。连接器只同步必要的 Task 元数据、运行摘要和 Approval，不默认上传工作知识正文。

验收：凭证不落知识库；连接器权限与可访问数据范围可审计；外部写入幂等；失败可重试且不会重复发送。

### M7：终端界面与 Web 控制面

在 CLI 命令和状态契约稳定后增加 `ikb tui`；Web 控制面最后建设，只调用同一应用服务和查询模型。

验收：TUI/Web 显示结果与 CLI 一致；任何写操作都会生成相同事件；删除界面层不影响任务执行和数据恢复。

### M8：Harness 进化

实现周度 OUTER LOOP、经验语料、决策预测验证和规则补丁队列。

验收：改进建议能追溯到真实 Run；补丁应用前有审批和回滚；同类失败第二次出现时能命中已验证修法；无效果的规则会被识别而不是继续堆叠。

## 推荐的第一条纵向切片

第一条完整切片选“写技术方案”，不先选编码。原因是它能穿透 Knowledge、Task、Run、Agent、Skill、Approval、Artifact 和结果回写八个核心对象，但没有代码执行和外部发送风险。

具体流程：

```text
创建 document Task
  → 填目标、读者和验收
  → 检索相关知识与写作偏好
  → Document Agent 生成方案
  → fact/source check
  → CLI 展示草稿与引用
  → 用户修改或接受
  → 记录差异和结果
  → 生成偏好/方法候选知识
```

这条切片通过后，再接 coding + review，最后接外部 CR 评论和大象发送。

## 成功指标

不使用笔记总数、Token 消耗或 Agent 运行次数衡量价值。MVP 观察四组指标：

| 维度 | 指标 |
|---|---|
| 知识质量 | 有来源比例、冲突率、过期率、真实引用后验证率 |
| 任务效果 | 首次通过率、人工修改幅度、验收通过率、恢复成功率 |
| 自动化价值 | 草稿接受率、节省的人工步骤、重复任务复用率 |
| 安全性 | 越权阻断次数、重复外部写入数、敏感数据扫描问题数 |

每个工作流先用 shadow 模式跑真实任务。只有验收通过率和安全指标稳定，才从草稿开放到本地写入；外部写入仍保留人工门禁。

## 方案确认后的实现拆分

方案确认后按里程碑创建 Task，不建立一个覆盖全部工作的巨大方案包：

1. bootstrap-monorepo：工程骨架、contract schema、示例 Vault。
2. build-local-ledger：Task/Run/Approval/Artifact、事件账本和 CLI 查询视图。
3. build-knowledge-core：capture、ingest、search、context、doctor。
4. build-harness-runtime：Agent/Skill、checkpoint、恢复和 Action Gateway。
5. add-document-workflow：第一条纵向切片。
6. add-coding-review-cr：代码工作流与隔离执行。
7. add-external-connectors：按连接器逐个评审权限和幂等。
8. add-operator-ui：先 TUI，后 Web。

1、3、5 可以使用 A/B 级 Task；2、4、6、7 涉及稳定状态、执行隔离或外部权限，使用 C 级 Plan Pack；8 只消费稳定接口，不得反向修改核心状态语义。

这里的 3 是实现本方案已冻结的知识契约；如果实现中需要改变 Knowledge 状态、frontmatter 字段语义或迁移规则，应转为 C 级 Plan Pack，而不是边写边改契约。详细任务拆分见[完整落地计划](implementation-plan.md)。
