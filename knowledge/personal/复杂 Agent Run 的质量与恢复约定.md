---
id: complex-agent-run-quality-recovery
title: 复杂 Agent Run 的质量与恢复约定
aliases: [Harness Run, Run 质量闭环, Agent Run 恢复, 外部动作幂等]
updated_at: 2026-09-02
tags: [个人方法, Harness, 质量, 恢复, Approval]
sources: []
public_evidence: original_sources_not_distributed
---

## 是什么／怎么做

对有多步骤、Artifact、人工批准或外部副作用的 Agent Run，控制面记录可恢复的 Step、Artifact、Gate、Verifier、Evaluation、Approval 与 Action；模型只负责当前步骤的语义工作。运行终态、Verifier、Evaluation 与 Task acceptance 分开判断，`succeeded` 不能单独证明质量或业务验收。

验收证据再分为三层：组件层说明动作空间、可见改动和回退入口；经验层保留可下钻的执行轨迹与失败模式；结果层检查最终交付物和消费者结果。三层不能互相代替，只有结果产物而看不到动作与轨迹时，仍不足以解释或安全恢复一次 Run。

外部动作以 `action_id + target_hash + payload_hash` 识别：三项相同才可复用已有结果；任一变化都视为新动作并重新 Approval。Outer Loop 仅把足够独立的重复失败整理为待人工确认、带回归用例的候选，不自动修改 Skill、Knowledge、门禁或权限。

跨会话检查点必须同时保留“已完成”和“待完成”：只注入 pending 或 in-progress 会让后续 Agent 重做已结束的工作。对会改变决策的操作，检查点还要保留确切命令、结果、错误和进度位置；无需复制全部原始日志，但不能用“已修复”这类丢失证据的摘要替代。

评审波次还要冻结同一 source snapshot：所有只读 reviewer 完成并汇总前不启动 writer，否则不同 reviewer 会看到修复前、红测中间态和修复后的不同产品。执行状态与质量结论分字段表达；“审查任务 completed”不等于 verdict=pass。最终通过同时要求回归通过、所需 reviewer 一致通过和快照未变化，后续 scoped write 或 BLOCKED 会使旧 verdict 失效。

子任务已经产出可直接交付的 Handoff 时，若根节点只需原样转发，不再重新启动管理 Agent 做机械复述。运行时可在校验父子关系、Handoff 类型、Artifact 哈希（及必要摘要）和未消费状态后，原子完成“标记已消费 + 根任务终态”；只有状态冲突、证据损坏、人工门禁、新用户输入或需要新决策时才唤醒管理 Agent。

## 什么时候用

设计、启动、恢复或评审复杂 Agent Run，以及判断一次 Run 是否真完成时使用。

## 什么时候别信

这是个人通用方法，不替代当前任务合同、领域 Verifier、仓库实现或实际授权。没有 Artifact、Gate、Verifier 和约定的业务结果时，不能据此宣称 Run 已验收。确定性 Handoff Relay 在来源中是尚未实施的优化建议，不证明任何当前 Runtime 已支持。
