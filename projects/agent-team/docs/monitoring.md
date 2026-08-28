# Agent Team 持续效果监控

Agent Team 已接入 IKB Harness。自动采集走现有 IKB 维护任务，每 6 小时只读扫描 Codex 原生 rollout；效果判断继续走 Eval Plane Campaign。插件本身没有新增 Hook、Runtime 或完成门禁。

## 两层数据

自动遥测按 Codex turn 落盘，不按整个 thread 混算。采集器使用 task_started/task_complete 划分 turn，通过 subagent_history_start_ordinal 排除子线程复制的父历史，再把同一时间窗内的后代 turn 汇总到根 turn。

自动层记录 CLI、模型、运行控制哈希、Agent Team 安装身份、墙钟、根子线程 token，以及 spawn/followup/wait/send/interrupt 等原生协作调用。Prompt、模型输出、文件路径和工具输出不会进入观测 Artifact。

质量层不能从 task_complete 推断。进入 Campaign 的样本必须另外提供 L1、L3、人工介入、期望 spawn、writer 冲突和 review 快照漂移，并绑定安全 evidence ref。父子重复读取在当前 Codex rollout 中没有结构化 read target，自动结果保持 unknown；需要评测时由带证据标签补齐，不能靠 shell 文本猜路径。

## 自动入口

日常维护已经增加 agent-team-observe：

```bash
/Users/htwu/projects/_personal/ikb/bin/ikb harness agent-team collect --json
```

它只采集明确加载 `agent-teams@ikb-agent-team` 2.0.0 的已终止 turn。首次从 2026-08-26 开始回看；后续根据最新 Artifact 保留 24 小时重叠窗口，重复输入复用同一内容寻址文件。

维护任务使用 --fail-open。采集不可用时返回 unavailable 和 reason code，并留下 maintenance-step Artifact；知识维护不被监控故障阻断。当前本机 LaunchAgent 每 21600 秒运行一次维护。

自动遥测位于：

```text
ikb-data/evaluations/agent-team-rollouts/
```

## Campaign 入口

受控 A/B 使用冻结 Manifest 和带证据样本：

```bash
/Users/htwu/projects/_personal/ikb/bin/ikb harness agent-team campaign \
  --manifest /absolute/path/campaign-manifest.json \
  --samples /absolute/path/campaign-samples.json \
  --json
```

命令会依次生成 rollout telemetry、带质量标签的 result Artifact、CampaignObservation 文档和聚合 Campaign 报告。它先索引 session_meta，只完整解析样本根线程及其后代；无关历史 JSONL 损坏不会污染本次 Campaign，目标样本损坏仍会阻断。

结果分别落在：

```text
ikb-data/evaluations/agent-team-campaign-results/
ikb-data/evaluations/agent-team-campaign-inputs/
ikb-data/evaluations/campaigns/
```

## 首轮结果

2026-08-26 的三组成对案例已重新通过正式入口，形成 6 条 Observation：

| 指标 | 结果 |
|---|---:|
| A/B 配对 | 3/3 |
| L1 失败 | 基线 0，候选 0 |
| L3 通过率 | 基线 100%，候选 100% |
| spawn 判断 | 5 次正确，1 次基线误 spawn，0 次漏 spawn |
| 平均总 token | 基线 283,941，候选 205,515，候选低 27.62% |
| 平均墙钟 | 基线 48.21s，候选 43.04s，候选低 10.71% |
| writer 冲突 | 0 |
| review 漂移 | 6 条 unknown |
| 父子重复读取 | 0 条有标签 |

Campaign 终态为 inconclusive，reasonCode 是 l3_improvement_not_proven。三组质量全部打平，成本下降不能单独证明能力提升；这批数据支持继续受控试用，不支持宣布长期提效。

对应输入是 [Campaign Manifest](evals/2026-08-26-campaign-manifest.json) 和 [带证据样本](evals/2026-08-26-campaign-samples.json)，聚合报告按 evaluationKey 幂等复用。
