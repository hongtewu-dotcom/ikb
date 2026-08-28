# Campaign：判断 Harness 是否真的变好

Campaign 是 Eval Plane 的跨 Run 决策层。它不执行 Agent，也不替 Harness 创建任务；它只消费同一批真实任务在基线版和候选版下产生的终态观测，输出 `promote`、`reject` 或 `inconclusive`。

## 输入边界

Manifest 冻结四类信息：基线和候选 Harness 的配置哈希、模型与仓库等运行控制项的联合哈希、隐藏任务集的 cohort 哈希，以及晋级阈值。隐藏任务正文和逐项答案不进入 Manifest。

Observation 由 Harness 在最终消费者验收后生成。每条记录只包含不透明任务哈希、试验轮次、L1 是否通过、L3 终态和 L2 成本。Prompt、模型输出、文件路径和逐项 ground truth 不允许进入合同。

同一任务可以重复运行，但统计检验以任务为独立样本。重复轮次只用于估计该任务的随机性，不能靠增加重复次数制造显著性。

## 判定顺序

Campaign 先检查 cohort、运行控制项、分层和 A/B 配对是否完整。任一项不一致都返回 `inconclusive`。

数据可比后按固定顺序判定：候选 L1 超过容忍值直接 `reject`；L3 使用任务级配对胜负和单侧精确二项检验，效果未达到最小增量或置信要求返回 `inconclusive`；任一任务分层回退则 `reject`；L3 已证明改善后才检查 Token、耗时和人工介入预算，超预算同样 `reject`。不计算加权总分。

对 sealed holdout，报告只输出聚合计数、比例、显著性和配置身份，不输出任务哈希、逐项结果或失败明细。报告按 evaluationKey 内容寻址；相同输入复用同一文件，已有文件被篡改时拒绝复用。

## CLI

```bash
./bin/ikb harness campaign \
  --manifest /absolute/path/campaign.json \
  --observations /absolute/path/observations.json \
  --json
```

默认报告目录为 `<IKB_HOME>/evaluations/campaigns/<campaign-id>/`。可以用 `--report-dir` 指定其他绝对目录。

Agent Team 已提供正式 Observation 生产入口：

```bash
./bin/ikb harness agent-team campaign \
  --manifest /absolute/path/campaign.json \
  --samples /absolute/path/evidence-labelled-samples.json \
  --json
```

该入口从 Codex 原生 rollout 汇总根子线程成本，只读取样本根线程及其后代，并要求每个质量结论绑定 evidence ref。自动遥测与质量标签分层：task_complete 只能证明 turn 终止，不能自动生成 L1/L3 pass。

当前切片已经实现合同校验、聚合判定、盲测输出和幂等持久化。它不能单独证明现有 Harness 已经变好；必须先由目标 Harness 在冻结的真实任务集上生成 A/B Observation。没有这批真实输入时，CLI 跑通只能证明评估机制可用，不能作为 Harness 晋级证据。
