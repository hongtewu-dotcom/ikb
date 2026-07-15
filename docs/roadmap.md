# ikb 路线图与验收

## 建设顺序

第一版不追求一次接管所有工作。顺序按风险和闭环完整度排：先证明知识能被正确引用，再证明任务能被观察和恢复，最后开放外部动作。

### M0：方案与边界

产出：主架构、对象契约、权限等级、数据分区、首批工作流和 Spec 使用判定。

验收：知识、Issue、Run 三类记录没有职责重叠；公开仓与真实 Vault 的边界明确；所有外部副作用都有门禁归属。

### M1：知识底座

实现 Markdown Vault、扁平 frontmatter、来源登记、候选准入、统一 search、引用追踪和 doctor。

首批 CLI：

```text
ikb init
ikb capture
ikb ingest
ikb search
ikb context
ikb review
ikb doctor
```

验收：可以从脱敏材料生成 draft 知识；verified 必须有证据；删除派生索引后能重建；personal/work 结果不会越界混用。

### M2：Issue 控制面

实现 Issue、Run、Gate、Artifact、Agent、Skill 和事件时间线；提供本地 Web 控制面。

验收：可以创建 Issue、选择 Agent/Skill、启动 Run、暂停到 human gate、恢复、失败后重试并查看全部产物；刷新或重启后状态不丢。

### M3：低风险工作流

先接文档和沟通草稿。这两类工作能验证知识引用、写作偏好、人工门禁和结果回写，又不会修改代码或外部系统。

验收：完成“创建 Issue → 生成 context pack → 产出草稿 → 人工修改/接受 → 记录差异 → 形成知识候选”的闭环；连续真实使用两周后，统计接受率和主要修改原因。

### M4：编码、评审与 CR

接入 Git worktree、代码搜索、GitNexus、构建测试和 reviewer；实现编码、评审和 CR 三个 Agent。

验收：编码 Run 有隔离工作区、测试和 diff；评审结论带文件/行号与证据；CR 外部评论和 push 无法绕过人工门禁；失败 Run 可以从 checkpoint 恢复。

### M5：外部系统与远程控制

按需接入 ONES、学城、大象、日历和远程 Agent runtime。远端控制面只同步 Issue 元数据、运行摘要和门禁，不默认上传工作知识正文。

验收：凭证不落知识库；连接器权限与可访问数据范围可审计；外部写入幂等；失败可重试且不会重复发送。

### M6：Harness 进化

实现周度 OUTER LOOP、经验语料、决策预测验证和规则补丁队列。

验收：改进建议能追溯到真实 Run；补丁应用前有审批和回滚；同类失败第二次出现时能命中已验证修法；无效果的规则会被识别而不是继续堆叠。

## 推荐的第一条纵向切片

第一条完整切片选“写技术方案”，不先选编码。原因是它能穿透 Knowledge、Issue、Run、Agent、Skill、Gate、Artifact 和结果回写七个核心对象，但没有代码执行和外部发送风险。

具体流程：

```text
创建 document Issue
  → 填目标、读者和验收
  → 检索相关知识与写作偏好
  → Document Agent 生成方案
  → fact/source gate
  → 控制面展示草稿与引用
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

方案确认后按里程碑创建 Issue，不立即建立一个覆盖全部工作的巨大 Spec：

1. bootstrap-monorepo：工程骨架、contract schema、示例 Vault。
2. build-knowledge-core：capture、ingest、search、context、doctor。
3. build-issue-control-plane：Issue/Run/Gate/API 与本地控制面。
4. add-document-workflow：第一条纵向切片。
5. add-coding-review-cr：代码工作流与隔离执行。
6. add-external-connectors：按连接器逐个评审权限和幂等。

其中 1、2、4 可使用普通 Issue + 验收；3 涉及状态与持久化 schema，5 涉及执行隔离与副作用，6 涉及外部权限，后三项应使用 SpecX。

这里的 2 是实现本方案已冻结的知识契约；如果实现中需要改变 Knowledge 状态、frontmatter 字段语义或迁移规则，应立即升级为 SpecX，而不是边写边改契约。
