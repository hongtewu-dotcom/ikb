# IKB

IKB 是本地 Markdown 知识库：通过 CLI 搜索和回读卡片，用受控请求维护知识，并在本机工作台查看待决策事项与知识库状态。`platform-v1` 已冻结，冻结代码不在本次公开快照中。

## 本次 Git 快照

这是经过筛选的代码与公开知识快照。`knowledge/` 只保存可分发的个人、通用知识副本；活动知识真源仍在本机 `ikb-data/cards/`，没有随 Git 上传。原始会话、内部业务知识、人物观察、附件、运行记录与私有来源均不属于公开知识交付。

- [知识副本与使用限制](knowledge/README.md)
- [上传边界](docs/git-publication-policy.md)
- 本机检索：`node scripts/ikb-cards-cli.mjs search --scope work --query "对象 问题 动作"`
- 按搜索返回的标识回读：`node scripts/ikb-cards-cli.mjs get --retrieval-id ID --card-id ID`
- 本机工作台：`npm run ikb:workbench:serve`，默认只监听回环地址。

运行需要 Node.js 22.6 或更新版本及已安装依赖。示例公开卡片可以通过 `IKB_CARDS_ROOT` 指定；它们不包含完整工作库或私有证据，不能据此验证工作业务结论。`IKB_INTAKE_ROOT` 和检索缓存目录应设在本机私有数据目录。默认活动库位于仓库旁的 `ikb-data/cards/`；公开副本需显式指定 `IKB_CARDS_ROOT=./knowledge`。

CLI 的 `feedback` 登记使用问题，`request-update` 登记明确更新；提交不代表发布完成。本快照提供请求登记和状态读取，不提供完整生产维护入口；本机生产环境的知识改稿由当前宿主的原生子 Agent 与独立消费者承担，主 Agent 核对证据、准入、发布和最终版本。未包含在公开快照中的私有来源及业务回归材料，不能由公开例子替代；缺少材料时维护应停止并报告缺口。

IKB 检索规则必须由宿主实际加载并执行。安装 CLI、写入 AGENTS.md、出现启动记忆，都不能证明一次真实任务已经执行 search/get。检索或读取次数也不代表知识正确或任务有效。

Usage statistics live in `ikb-data/usage/`; v2 activation selects the current collector and weekly report. For existing split layouts, stop collectors, back up both directories, preserve `usage/inject-log.jsonl`, archive other legacy files under `usage/archive/v1/`, and move `usage-v2` files into `usage/`. Remove the empty `usage-v2` directory before restarting collectors. Historical counts are not merged into v2.
