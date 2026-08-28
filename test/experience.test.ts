import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSource } from "../src/source.ts";
import { LedgerStore } from "../src/store.ts";
import { clusterExperienceRecords, listExperienceCandidates, listExperienceRecords, markExperienceAnalyzed, triageSessions, type ExperienceRecord } from "../src/experience.ts";
import { analyzeExperience, recordExperienceValidation, type ExperienceAnalysisInput } from "../src/experience-analysis.ts";
import { captureKnowledge } from "../src/knowledge.ts";

function source(home: string, directory: string, index: number): { id: string; recordId: string } {
  const path = join(directory, `session-${index}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: `session-${index}`, messageId: `u-${index}`, timestamp: `2026-07-21T0${index}:00:00Z`, content: "失败了，重试后不对。必须补充边界和校验，改成可验证的修复。" }),
    JSON.stringify({ role: "assistant", conversationId: `session-${index}`, messageId: `a-${index}`, timestamp: `2026-07-21T0${index}:01:00Z`, content: "确认根因，修复后安排回归验证。" }),
  ].join("\n") + "\n");
  const result = importSource(home, path, { kind: "ai_conversation", adapter: "claude", scope: "work" });
  return { id: result.source.id, recordId: result.records[0].id };
}

function runForSource(store: LedgerStore, sourceId: string, index: number, validate = false): string {
  const task = store.createTask({ title: `triage-${index}`, goal: "triage", acceptance: "evidence", scope: "work" });
  const run = store.createRun(task.id, "ikb-test", ["triage"]);
  store.recordSourceEvent(sourceId, "source.context_built", { runId: run.id, records: 2 });
  if (validate) {
    store.recordHarnessEvent(run.id, "run.verification_completed", { result: "pass", checks: [{ id: "real", decision: "pass", evidenceRefs: ["artifact-test"] }], artifactRefs: ["artifact-test"] });
  }
  return run.id;
}

function analysisInput(record: ExperienceRecord): ExperienceAnalysisInput {
  return {
    experienceId: record.id,
    title: "失败修复需要保留验证证据",
    summary: "会话记录了一次失败、人工纠偏、修复和回归验证要求。",
    disposition: "candidate",
    reason: "包含可在独立 Run 中复现和验证的工程经验。",
    findings: [{
      id: "f1",
      kind: "fact",
      statement: "本次会话在失败后要求修正方案并补充边界与验证。",
      evidenceRecordIds: [record.evidenceRecordIds[0]],
      evidenceEventIds: [],
    }],
    candidate: {
      changeType: "new",
      targetKnowledgeIds: [],
      patternKey: "engineering.fix-evidence-before-reuse",
      patternLabel: "修复经验先留证再复用",
      knowledgeType: "playbook",
      collection: "playbooks",
      canonicalClaim: "非显然修复只有保留失败证据、边界和回归结果后，才适合复用。",
      applicability: "处理曾失败或被人工纠偏的工程任务时。",
      boundary: "不适用于没有真实失败或验证记录的普通成功任务。",
      useWhen: "遇到相似失败并准备复用历史修复方案时。",
      steps: ["定位失败证据", "记录修复动作", "执行回归验证"],
      checks: ["失败与修复可由同一证据链追溯"],
      stopConditions: ["无法找到原始失败证据时停止套用"],
      validationPlan: "在独立 Run 中复现失败并确认修复后的门禁通过。",
    },
    counterevidence: {
      searched: true,
      scope: "当前 Experience 的完整会话记录",
      evidenceRecordIds: [],
      result: "未发现表明无需验证即可复用修复方案的反例。",
    },
    unknowns: [],
  };
}

function analyzeAll(home: string, store: LedgerStore): void {
  for (const record of listExperienceRecords(home, "work")) {
    analyzeExperience(home, store, record, analysisInput(record), (analysis) => markExperienceAnalyzed(home, analysis));
  }
}

test("Session Triage stores evidence references, skips tool output and never writes Knowledge", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const path = join(inputs, "session.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "triage", messageId: "u1", content: "不对，失败后要重跑，必须补充边界。" }),
    JSON.stringify({ role: "tool", conversationId: "triage", messageId: "t1", content: "巨大的工具输出 error error error" }),
    JSON.stringify({ role: "assistant", conversationId: "triage", messageId: "a1", content: "修复根因并做回归。" }),
  ].join("\n") + "\n");
  const imported = importSource(home, path, { kind: "ai_conversation", adapter: "claude", scope: "work" });
  const store = new LedgerStore({ home });
  const result = triageSessions(home, store, { scope: "work", adapter: "claude" });
  assert.equal(result.scannedSources, 1);
  assert.equal(result.selected, 1);
  assert.equal(result.created, 1);
  assert.equal(result.skippedToolRecords, 1, "triage excludes any tool records that entered a generic Source");
  const records = listExperienceRecords(home, "work");
  assert.equal(records.length, 1);
  assert.ok(records[0].evidenceRecordIds.some((id) => id.includes(imported.source.id)));
  assert.ok(records[0].signalCodes.includes("manual_correction"));
  assert.equal(existsSync(join(home, "vaults")), false);
  assert.equal(store.listEvents().filter((event) => event.eventType === "experience.queued").length, 1);
  const second = triageSessions(home, store, { scope: "work", adapter: "claude" });
  assert.equal(second.created, 0);
  assert.equal(second.unchanged, 1);
  store.close();
});

test("Session Triage materializes an unmapped partial Knowledge feedback as an event-backed Experience", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-feedback-triage-"));
  const home = join(sandbox, "ikb-data");
  const evidencePath = join(sandbox, "consumer-result.md");
  writeFileSync(evidencePath, "# Consumer result\n\nThe card supplied structure but missed the rewrite method.\n");
  const store = new LedgerStore({ home });
  const knowledge = captureKnowledge(home, {
    title: "技术方案评审结构",
    scope: "work",
    type: "playbook",
    collection: "playbooks",
    body: "技术方案按目标、事实、方案和验证组织。",
  });
  const task = store.createTask({ title: "技术文档重写", goal: "重写一份难懂文档", acceptance: "结构和事实可核对", scope: "work" });
  const run = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"]);
  const artifact = store.createArtifact({ runId: run.id, path: evidencePath, kind: "canary-result", label: "consumer result" });
  const malformed = store.recordKnowledgeEvent(knowledge.id, "knowledge.feedback_recorded", {
    taskId: task.id,
    runId: run.id,
    outcome: "partial",
    reasonCode: "legacy_feedback_without_artifact",
    evidenceRefs: [],
  });
  const feedback = store.recordKnowledgeEvent(knowledge.id, "knowledge.feedback_recorded", {
    taskId: task.id,
    runId: run.id,
    outcome: "partial",
    reasonCode: "rewrite_method_missing",
    evidenceRefs: [`artifact://${artifact.id}`],
  });

  const result = triageSessions(home, store, { scope: "work", adapter: "all" });
  assert.equal(result.feedbackSelected, 1);
  assert.equal(result.feedbackCreated, 1);
  assert.equal(result.unmappedFeedbackEvents, 0);
  const records = listExperienceRecords(home, "work");
  assert.equal(records.length, 1);
  assert.equal(records[0].adapter, null);
  assert.deepEqual(records[0].signalCodes, ["knowledge_feedback"]);
  assert.deepEqual(records[0].evidenceEventIds, [feedback.eventId]);
  assert.notDeepEqual(records[0].evidenceEventIds, [malformed.eventId]);
  assert.deepEqual(records[0].runIds, [run.id]);
  assert.deepEqual(records[0].sourceIds, []);

  const again = triageSessions(home, store, { scope: "work", adapter: "all" });
  assert.equal(again.feedbackCreated, 0);
  assert.equal(again.feedbackUnchanged, 1);
  store.close();
});

test("an event-backed feedback Experience can revise its target Knowledge but cannot create unrelated Knowledge", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-feedback-analysis-"));
  const home = join(sandbox, "ikb-data");
  const evidencePath = join(sandbox, "consumer-result.md");
  writeFileSync(evidencePath, "# Consumer result\n\nThe card was partial in a real task.\n");
  const store = new LedgerStore({ home });
  const knowledge = captureKnowledge(home, {
    title: "技术方案评审结构",
    scope: "work",
    type: "playbook",
    collection: "playbooks",
    body: "技术方案按目标、事实、方案和验证组织。",
  });
  const task = store.createTask({ title: "技术文档重写", goal: "重写一份难懂文档", acceptance: "结构和事实可核对", scope: "work" });
  const run = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"]);
  const artifact = store.createArtifact({ runId: run.id, path: evidencePath, kind: "canary-result", label: "consumer result" });
  const feedback = store.recordKnowledgeEvent(knowledge.id, "knowledge.feedback_recorded", {
    taskId: task.id,
    runId: run.id,
    outcome: "incorrect",
    reasonCode: "rewrite_method_wrong",
    evidenceRefs: [artifact.id],
  });
  triageSessions(home, store, { scope: "work", adapter: "all" });
  const record = listExperienceRecords(home, "work")[0];
  const revise: ExperienceAnalysisInput = {
    experienceId: record.id,
    title: "技术文档重写规则需要修订",
    summary: "真实消费者指出现有评审结构不能覆盖结构性重写。",
    disposition: "candidate",
    reason: "结构化 incorrect feedback 绑定了真实 Run 和结果 Artifact。",
    findings: [{
      id: "feedback-fact",
      kind: "fact",
      statement: "现有 Knowledge 在真实文档重写任务中被判定为 incorrect。",
      evidenceRecordIds: [],
      evidenceEventIds: [feedback.eventId],
    }],
    candidate: {
      changeType: "revise",
      targetKnowledgeIds: [knowledge.id],
      patternKey: "writing.revise-structure-after-consumer-feedback",
      patternLabel: "按真实消费者反馈修订写作结构",
      knowledgeType: "playbook",
      collection: "playbooks",
      canonicalClaim: "现有评审结构不能替代收到结构性反馈后的重写方法。",
      applicability: "已有技术文档被真实消费者指出结构性失真时。",
      boundary: "不从一次反馈推断通用写作偏好，也不创建无关知识。",
      useWhen: "修订当前技术文档评审 Knowledge 时。",
      steps: ["回放消费者 Artifact", "定位缺失契约", "生成正文级修订稿"],
      checks: ["反馈事件、Run、Artifact 和目标 Knowledge 可追溯"],
      stopConditions: ["Artifact 不存在或反馈目标不一致时停止"],
      validationPlan: "用同类真实文档任务验证修订前后效果。",
    },
    counterevidence: {
      searched: true,
      scope: "当前 feedback Event、目标 Knowledge 和消费者 Artifact",
      evidenceRecordIds: [],
      result: "未发现本次消费者认为现有卡已完整覆盖重写方法的反证。",
    },
    unknowns: [],
  };
  const result = analyzeExperience(home, store, record, revise, (analysis) => markExperienceAnalyzed(home, analysis));
  assert.equal(result.analysis.candidate?.changeType, "revise");
  assert.deepEqual(result.analysis.candidate?.targetKnowledgeIds, [knowledge.id]);

  assert.throws(() => analyzeExperience(home, store, record, {
    ...revise,
    candidate: {
      ...revise.candidate!,
      changeType: "new",
      targetKnowledgeIds: [],
    },
  }, (analysis) => markExperienceAnalyzed(home, analysis)), /event-backed Knowledge feedback can only revise or retire its target Knowledge/);
  store.close();
});

test("Experience clustering requires independent Runs and produces a pending Knowledge Candidate", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-cluster-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const store = new LedgerStore({ home });
  for (let index = 1; index <= 3; index += 1) {
    const item = source(home, inputs, index);
    runForSource(store, item.id, index);
  }
  const triage = triageSessions(home, store, { scope: "work", adapter: "claude" });
  assert.equal(triage.selected, 3);
  analyzeAll(home, store);
  const cluster = clusterExperienceRecords(home, store, { scope: "work", minimumSamples: 3 });
  assert.equal(cluster.eligible, 1);
  assert.equal(cluster.created, 1);
  assert.equal(cluster.candidates[0].status, "pending_review");
  assert.equal(cluster.candidates[0].candidateKnowledge.claim, "非显然修复只有保留失败证据、边界和回归结果后，才适合复用。");
  assert.equal(cluster.candidates[0].independentRunCount, 3);
  assert.equal(listExperienceCandidates(home, "work").length, 1);
  assert.equal(existsSync(join(home, "vaults")), false);
  const again = clusterExperienceRecords(home, store, { scope: "work", minimumSamples: 3 });
  assert.equal(again.created, 0);
  assert.equal(again.unchanged, 1);
  assert.equal(store.listEvents().filter((event) => event.eventType === "experience.candidate_created").length, 1);
  store.close();
});

test("Two independent agent Runs need an analysis-specific Artifact validation before promotion", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-validation-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const store = new LedgerStore({ home });
  for (let index = 1; index <= 2; index += 1) {
    const item = source(home, inputs, index);
    runForSource(store, item.id, index, index === 2);
  }
  triageSessions(home, store, { scope: "work", adapter: "claude" });
  analyzeAll(home, store);
  const beforeValidation = clusterExperienceRecords(home, store, { scope: "work", minimumSamples: 3 });
  assert.equal(beforeValidation.eligible, 0);
  const record = listExperienceRecords(home, "work")[0];
  const validationPath = join(sandbox, "real-validation.txt");
  writeFileSync(validationPath, "independent reproduction passed\n");
  const artifact = store.createArtifact({ runId: record.runIds[0], kind: "experience-validation", label: "independent reproduction", path: validationPath });
  recordExperienceValidation(home, store, record, {
    result: "pass",
    method: "在独立任务中复现失败并执行修复后的回归检查",
    note: "失败可复现，修复后检查通过。",
    artifactId: artifact.id,
  });
  const cluster = clusterExperienceRecords(home, store, { scope: "work", minimumSamples: 3 });
  assert.equal(cluster.eligible, 1);
  assert.equal(cluster.candidates[0].validationRefs.length, 1);
  store.close();
});

test("Experience Candidate keeps mirrored Source refs but counts one independent source snapshot", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-mirror-source-count-"));
  const home = join(sandbox, "ikb-data");
  const path = join(sandbox, "mirrored-session.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "mirror", messageId: "u1", timestamp: "2026-07-21T01:00:00Z", content: "这个结论不对，必须修订现有规则并补验证。" }),
    JSON.stringify({ role: "assistant", conversationId: "mirror", messageId: "a1", timestamp: "2026-07-21T01:01:00Z", content: "确认反例，修复后执行回归。" }),
  ].join("\n") + "\n");
  const first = importSource(home, path, { kind: "ai_conversation", adapter: "claude", scope: "work" });
  const second = importSource(home, path, { kind: "ai_conversation", adapter: "claude", scope: "work" });
  const target = captureKnowledge(home, { title: "待修订规则", scope: "work", type: "playbook", collection: "playbooks", body: "旧规则。" });
  const store = new LedgerStore({ home });
  triageSessions(home, store, { scope: "work", adapter: "claude" });
  const initial = listExperienceRecords(home, "work")[0];
  const experiencePath = join(home, "experiences", "work", `${initial.id}.json`);
  writeFileSync(experiencePath, `${JSON.stringify({
    ...initial,
    sourceIds: [first.source.id, second.source.id],
    sourceOriginHash: createHash("sha256").update([first.source.contentHash, second.source.contentHash].join("|")).digest("hex"),
  }, null, 2)}\n`);
  const record = listExperienceRecords(home, "work")[0];
  const input = analysisInput(record);
  input.candidate = {
    ...input.candidate!,
    changeType: "revise",
    targetKnowledgeIds: [target.id],
    patternKey: "engineering.revise-mirrored-source-count",
  };
  analyzeExperience(home, store, record, input, (analysis) => markExperienceAnalyzed(home, analysis));
  const candidate = clusterExperienceRecords(home, store, { scope: "work" }).candidates[0];
  assert.deepEqual(new Set(candidate.sourceIds), new Set([first.source.id, second.source.id]));
  assert.equal(candidate.independentSourceCount, 1);
  store.close();
});

test("Session Triage ignores runtime envelopes, embedded tool results and evaluation subjects", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-noise-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const path = join(inputs, "noise.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "tool-noise", messageId: "u1", content: "帮我看一下这个项目。" }),
    JSON.stringify({ role: "assistant", conversationId: "tool-noise", messageId: "a1", content: "[external_agent_tool_result] 文档里写了失败、重试、Verifier 驳回和修复。 [/external_agent_tool_result]" }),
    JSON.stringify({ role: "user", conversationId: "system-noise", messageId: "u2", content: "<sandbox_context>必须校验，失败后重试。</sandbox_context>\n\n把 md 默认改成预览。" }),
    JSON.stringify({ role: "assistant", conversationId: "system-noise", messageId: "a2", content: "已修改设置。" }),
    JSON.stringify({ role: "user", conversationId: "evaluation-noise", messageId: "u3", content: "# 知识质量第二轮检查\n\n被评估卡片写着：失败后重试，必须补充边界和验证。\n\n## 输出格式\n只输出 JSON。" }),
    JSON.stringify({ role: "assistant", conversationId: "evaluation-noise", messageId: "a3", content: "{\"notes\":\"建议回原文复核\"}" }),
    JSON.stringify({ role: "user", conversationId: "real-event", messageId: "u4", content: "继续处理刚才的任务。" }),
    JSON.stringify({ role: "assistant", conversationId: "real-event", messageId: "a4", content: "checkout 失败，当前被环境变量阻断；环境恢复后重试。" }),
  ].join("\n") + "\n");
  importSource(home, path, { kind: "ai_conversation", adapter: "codex", scope: "work" });
  const store = new LedgerStore({ home });

  const result = triageSessions(home, store, { scope: "work", adapter: "codex" });
  assert.equal(result.scannedSessions, 4);
  assert.equal(result.selected, 1);
  assert.equal(result.records[0]?.sourceTitle.includes("noise"), true);
  const records = listExperienceRecords(home, "work");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].signalCodes, ["failure_or_block", "retry"]);
  assert.equal(records[0].triageDisposition, "selected");
  assert.ok(result.skippedToolRecords + result.skippedNonEventRecords >= 2);
  store.close();
});

test("Session Triage does not treat explicit success or negated errors as failures", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-negation-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const path = join(inputs, "success.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "success", messageId: "u1", content: "把 Markdown 默认打开方式改成预览。" }),
    JSON.stringify({ role: "assistant", conversationId: "success", messageId: "a1", content: "改好了。JSON 已校验，没有语法错误，也未发现异常。" }),
  ].join("\n") + "\n");
  importSource(home, path, { kind: "ai_conversation", adapter: "desk", scope: "work" });
  const store = new LedgerStore({ home });

  const result = triageSessions(home, store, { scope: "work", adapter: "desk" });
  assert.equal(result.scannedSessions, 1);
  assert.equal(result.selected, 0);
  assert.equal(result.ignoredSessions, 1);
  assert.equal(listExperienceRecords(home, "work").length, 0);
  store.close();
});

test("Session Triage ignores automated prompt sessions, conditional failures and successful build warnings", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-semantic-noise-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const path = join(inputs, "semantic-noise.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "automated", messageId: "u1", content: "# System\n你是业务知识结构化提取引擎。必须输出边界、失败路径和验证规则。" }),
    JSON.stringify({ role: "assistant", conversationId: "automated", messageId: "a1", content: "文档说明失败后重试，并补充了异常边界。" }),
    JSON.stringify({ role: "user", conversationId: "business-rule", messageId: "u2", content: "往返燃油费如何查询？" }),
    JSON.stringify({ role: "assistant", conversationId: "business-rule", messageId: "a2", content: "如果任一程请求失败，就按航线里程走兜底逻辑；这描述的是业务规则。" }),
    JSON.stringify({ role: "user", conversationId: "successful-build", messageId: "u3", content: "编译结果怎样？" }),
    JSON.stringify({ role: "assistant", conversationId: "successful-build", messageId: "a3", content: "BUILD SUCCESS。[ERROR] version is missing 是 enforcer 告警，非编译错误，不影响构建。" }),
    JSON.stringify({ role: "user", conversationId: "automation", messageId: "u4", content: "<automation_context name=\"巡检\">每天检查文档并输出报告。</automation_context>\n收到任务后执行断链检查。" }),
    JSON.stringify({ role: "assistant", conversationId: "automation", messageId: "a4", content: "巡检完成；历史文档只包含错误码说明，本次无新增断链。" }),
    JSON.stringify({ role: "user", conversationId: "prompt-design", messageId: "u5", content: "把定时任务的提示词精简一下。" }),
    JSON.stringify({ role: "assistant", conversationId: "prompt-design", messageId: "a5", content: "原提示词包含 SSO 失败后重试和手动调用接口的兜底说明，现已删除这些实现细节。" }),
    JSON.stringify({ role: "user", conversationId: "chinese-job", messageId: "u6", content: "你要完成一个\"经验沉淀\"任务。\n## 收录标准\n出现失败、重试和人工纠偏。\n## 你需要执行的步骤\n1. 扫描资料。\n## 输出要求\n只输出报告。" }),
    JSON.stringify({ role: "assistant", conversationId: "chinese-job", messageId: "a6", content: "任务执行完毕。" }),
  ].join("\n") + "\n");
  importSource(home, path, { kind: "ai_conversation", adapter: "claude", scope: "work" });
  const store = new LedgerStore({ home });

  const result = triageSessions(home, store, { scope: "work", adapter: "claude" });
  assert.equal(result.scannedSessions, 6);
  assert.equal(result.selected, 0);
  assert.equal(result.ignoredSessions, 6);
  store.close();
});

test("Session Triage splits one long conversation into independent time-bounded episodes", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-episodes-"));
  const home = join(sandbox, "ikb-data");
  const path = join(sandbox, "long-session.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "long", messageId: "u1", timestamp: "2026-07-01T01:00:00Z", content: "这次输出不对，修复后要补验证。" }),
    JSON.stringify({ role: "assistant", conversationId: "long", messageId: "a1", timestamp: "2026-07-01T01:05:00Z", content: "已确认失败根因并修复。" }),
    JSON.stringify({ role: "user", conversationId: "long", messageId: "u2", timestamp: "2026-07-02T01:00:00Z", content: "这个图不对，应该先展示现状再展示目标。" }),
    JSON.stringify({ role: "assistant", conversationId: "long", messageId: "a2", timestamp: "2026-07-02T01:05:00Z", content: "已修正结构并重新验证。" }),
  ].join("\n") + "\n");
  importSource(home, path, { kind: "ai_conversation", adapter: "desk", scope: "work" });
  const store = new LedgerStore({ home });
  const result = triageSessions(home, store, { scope: "work", adapter: "desk" });
  assert.equal(result.scannedSessions, 2);
  assert.equal(result.selected, 2);
  const records = listExperienceRecords(home, "work").filter((record) => record.triageDisposition !== "ignored");
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((record) => record.sessionKeyHash)).size, 2);
  assert.equal(records.every((record) => record.sourceRecordIds.length === 2), true);
  store.close();
});

test("Experience clustering counts distinct conversations, not time-bounded episodes from one conversation", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-cluster-conversation-independence-"));
  const home = join(sandbox, "ikb-data");
  const path = join(sandbox, "one-conversation-two-episodes.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "one-conversation", messageId: "u1", timestamp: "2026-07-01T01:00:00Z", content: "这次修复不对，必须先保留失败证据和验证边界。" }),
    JSON.stringify({ role: "assistant", conversationId: "one-conversation", messageId: "a1", timestamp: "2026-07-01T01:05:00Z", content: "已记录失败原因，并补充回归验证。" }),
    JSON.stringify({ role: "user", conversationId: "one-conversation", messageId: "u2", timestamp: "2026-07-03T01:00:00Z", content: "这个方案还是不对，失败修复仍要保留失败证据和验证边界。" }),
    JSON.stringify({ role: "assistant", conversationId: "one-conversation", messageId: "a2", timestamp: "2026-07-03T01:05:00Z", content: "已按同一规则补充回归验证。" }),
  ].join("\n") + "\n");
  importSource(home, path, { kind: "ai_conversation", adapter: "codex", scope: "work" });
  const store = new LedgerStore({ home });
  triageSessions(home, store, { scope: "work", adapter: "codex" });
  const records = listExperienceRecords(home, "work").filter((record) => record.triageDisposition !== "ignored");
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((record) => record.sessionKeyHash)).size, 2, "the episodes remain separately analyzable");
  assert.equal(new Set(records.map((record) => record.conversationIdHash)).size, 1, "both episodes came from one agent conversation");
  analyzeAll(home, store);

  const cluster = clusterExperienceRecords(home, store, { scope: "work", minimumSamples: 2 });
  assert.equal(cluster.eligible, 0, "one conversation must not satisfy a two-run promotion gate by being split into episodes");
  assert.equal(cluster.pending[0].independentRunCount, 1);
  assert.equal(listExperienceCandidates(home, "work").length, 0);
  store.close();
});

test("Session Triage deduplicates the same conversation imported from multiple local history roots", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-cross-origin-dedup-"));
  const home = join(sandbox, "ikb-data");
  const firstPath = join(sandbox, "history-a.jsonl");
  const secondPath = join(sandbox, "history-b.jsonl");
  const content = [
    JSON.stringify({ role: "user", conversationId: "shared-conversation", messageId: "u1", timestamp: "2026-07-01T01:00:00Z", content: "这个方案不对，先定位失败原因再修复。" }),
    JSON.stringify({ role: "assistant", conversationId: "shared-conversation", messageId: "a1", timestamp: "2026-07-01T01:05:00Z", content: "已找到根因并补充回归验证。" }),
  ].join("\n") + "\n";
  writeFileSync(firstPath, content);
  writeFileSync(secondPath, content);
  importSource(home, firstPath, { kind: "ai_conversation", adapter: "codex", scope: "work" });
  importSource(home, secondPath, { kind: "ai_conversation", adapter: "codex", scope: "work" });
  const store = new LedgerStore({ home });
  const result = triageSessions(home, store, { scope: "work", adapter: "codex" });
  assert.equal(result.scannedSessions, 1);
  assert.equal(result.selected, 1);
  const records = listExperienceRecords(home, "work").filter((record) => record.triageDisposition !== "ignored");
  assert.equal(records.length, 1);
  assert.equal(records[0].sourceRecordIds.length, 2);
  store.close();
});

test("Session Triage distinguishes ordinary task instructions from explicit durable decisions", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-decision-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const path = join(inputs, "decisions.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "task", messageId: "u1", content: "盘点这些目录，必须查看边界和规则，最后输出报告。" }),
    JSON.stringify({ role: "assistant", conversationId: "task", messageId: "a1", content: "盘点完成。" }),
    JSON.stringify({ role: "user", conversationId: "decision", messageId: "u2", content: "我决定后续统一使用 properties，禁止新增 yml。" }),
    JSON.stringify({ role: "assistant", conversationId: "decision", messageId: "a2", content: "收到，作为后续项目约束。" }),
  ].join("\n") + "\n");
  importSource(home, path, { kind: "ai_conversation", adapter: "codex", scope: "work" });
  const store = new LedgerStore({ home });

  const result = triageSessions(home, store, { scope: "work", adapter: "codex" });
  assert.equal(result.scannedSessions, 2);
  assert.equal(result.selected, 1);
  const records = listExperienceRecords(home, "work");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].signalCodes, ["decision_or_rule"]);
  store.close();
});

test("Session Triage reconciles a stale prompt-only Experience and clustering excludes it", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-reconcile-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const path = join(inputs, "prompt.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "prompt-only", messageId: "u1", content: "你是统计子 agent。失败后重试，必须校验。只输出报告。" }),
    JSON.stringify({ role: "assistant", conversationId: "prompt-only", messageId: "a1", content: "报告已完成。" }),
  ].join("\n") + "\n");
  const imported = importSource(home, path, { kind: "ai_conversation", adapter: "desk", scope: "work" });
  const sessionKey = `desk|${imported.source.originalPath}|prompt-only`;
  const id = `exp-${createHash("sha256").update(sessionKey).digest("hex").slice(0, 12)}`;
  const directory = join(home, "experiences", "work");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({
    schema: "ikb-experience.v1",
    id,
    scope: "work",
    adapter: "desk",
    sourceTitle: imported.source.title,
    sourceIds: [imported.source.id],
    sourceOriginHash: imported.source.contentHash,
    sessionKeyHash: "a".repeat(32),
    conversationIdHash: "b".repeat(32),
    sourceRecordIds: imported.records.map((record) => record.id),
    evidenceRecordIds: imported.records.map((record) => record.id),
    evidenceEventIds: [],
    runIds: [],
    validationRefs: [],
    signalCodes: ["failure_or_block", "retry", "verifier_rejection"],
    signalCounts: {
      failure_or_block: 1,
      retry: 1,
      manual_correction: 0,
      verifier_rejection: 1,
      non_obvious_fix: 0,
      knowledge_feedback: 0,
      decision_or_rule: 1
    },
    status: "queued",
    firstSeenAt: "2026-07-21T00:00:00Z",
    lastSeenAt: "2026-07-21T00:00:01Z",
    createdAt: "2026-07-21T00:00:02Z",
    updatedAt: "2026-07-21T00:00:02Z"
  }, null, 2));
  const store = new LedgerStore({ home });

  const result = triageSessions(home, store, { scope: "work", adapter: "desk" });
  assert.equal(result.selected, 0);
  assert.equal(result.ignoredUpdated, 1);
  const reconciled = listExperienceRecords(home, "work")[0];
  assert.equal(reconciled.triageDisposition, "ignored");
  assert.deepEqual(reconciled.signalCodes, []);
  assert.ok(reconciled.exclusionReasons.includes("segmentation_superseded"));
  assert.equal(clusterExperienceRecords(home, store, { scope: "work" }).clusters, 0);
  store.close();
});

test("Session Triage retires legacy Experiences whose Sources left the active analysis plane", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-quarantine-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "specx-session.jsonl");
  writeFileSync(input, `${JSON.stringify({ role: "user", conversationId: "legacy", messageId: "u1", content: "失败了，需要重试。" })}\n`);
  const imported = importSource(home, input, { kind: "ai_conversation", adapter: "claude", scope: "work" });
  const sessionKey = `claude|${imported.source.originalPath}|legacy`;
  const id = `exp-${createHash("sha256").update(sessionKey).digest("hex").slice(0, 12)}`;
  const directory = join(home, "experiences", "work");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({
    schema: "ikb-experience.v1",
    id,
    scope: "work",
    adapter: "claude",
    sourceTitle: imported.source.title,
    sourceIds: [imported.source.id],
    sourceOriginHash: imported.source.contentHash,
    sessionKeyHash: "a".repeat(32),
    conversationIdHash: "b".repeat(32),
    sourceRecordIds: imported.records.map((record) => record.id),
    evidenceRecordIds: imported.records.map((record) => record.id),
    evidenceEventIds: [],
    runIds: [],
    validationRefs: [],
    signalCodes: ["failure_or_block", "retry"],
    signalCounts: {
      failure_or_block: 1,
      retry: 1,
      manual_correction: 0,
      verifier_rejection: 0,
      non_obvious_fix: 0,
      knowledge_feedback: 0,
      decision_or_rule: 0
    },
    status: "queued",
    firstSeenAt: "2026-07-21T00:00:00Z",
    lastSeenAt: "2026-07-21T00:00:01Z",
    createdAt: "2026-07-21T00:00:02Z",
    updatedAt: "2026-07-21T00:00:02Z"
  }, null, 2));
  const store = new LedgerStore({ home });

  const result = triageSessions(home, store, { scope: "work", adapter: "claude" });
  assert.equal(result.scannedSources, 0);
  assert.equal(result.inactiveSourceRecords, 1);
  assert.equal(result.ignoredUpdated, 1);
  const reconciled = listExperienceRecords(home, "work")[0];
  assert.equal(reconciled.triageDisposition, "ignored");
  assert.deepEqual(reconciled.signalCodes, []);
  assert.deepEqual(reconciled.exclusionReasons, ["source_outside_active_plane"]);
  store.close();
});
