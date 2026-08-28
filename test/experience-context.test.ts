import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildExperienceContext, materializeExperienceContext } from "../src/experience-context.ts";
import { EXPERIENCE_VERSION, type ExperienceRecord } from "../src/experience.ts";
import { captureKnowledge } from "../src/knowledge.ts";
import { importSource } from "../src/source.ts";
import { LedgerStore } from "../src/store.ts";

function fixture(home: string, sandbox: string): { record: ExperienceRecord; ids: string[] } {
  const path = join(sandbox, "session.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "context", messageId: "u1", timestamp: "2026-08-01T10:00:00Z", content: "先保留失败现场。" }),
    JSON.stringify({ role: "assistant", conversationId: "context", messageId: "a1", timestamp: "2026-08-01T10:01:00Z", content: "这条属于同一 Source，但不属于当前 Experience。" }),
    JSON.stringify({ role: "user", conversationId: "context", messageId: "u2", timestamp: "2026-08-01T10:02:00Z", content: "这个结论不对，重试前必须确认根因。" }),
  ].join("\n") + "\n");
  const imported = importSource(home, path, { kind: "ai_conversation", adapter: "codex", scope: "work" });
  const ids = imported.records.map((item) => item.id);
  return {
    ids,
    record: {
      schema: EXPERIENCE_VERSION,
      id: "exp-context-fixture",
      scope: "work",
      adapter: "codex",
      sourceTitle: "精确片段测试",
      sourceIds: [imported.source.id],
      sourceOriginHash: "a".repeat(64),
      sessionKeyHash: "b".repeat(64),
      conversationIdHash: "c".repeat(64),
      sourceRecordIds: [ids[2], ids[0]],
      evidenceRecordIds: [ids[2]],
      evidenceEventIds: [],
      runIds: [],
      validationRefs: [],
      signalCodes: ["manual_correction"],
      signalCounts: {
        failure_or_block: 0,
        retry: 0,
        manual_correction: 1,
        verifier_rejection: 0,
        non_obvious_fix: 0,
        knowledge_feedback: 0,
        decision_or_rule: 0,
      },
      triageDisposition: "selected",
      status: "queued",
      firstSeenAt: "2026-08-01T10:00:00Z",
      lastSeenAt: "2026-08-01T10:02:00Z",
      createdAt: "2026-08-01T10:03:00Z",
      updatedAt: "2026-08-01T10:03:00Z",
    },
  };
}

test("Experience context includes only the episode records, in chronological order, with evidence markers", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-context-"));
  const home = join(sandbox, "ikb-data");
  const { record, ids } = fixture(home, sandbox);

  const context = buildExperienceContext(home, record);
  assert.deepEqual(context.records.map((item) => item.id), [ids[0], ids[2]]);
  assert.deepEqual(context.records.map((item) => item.triageEvidence), [false, true]);
  assert.equal(context.totalRecords, 2);
  assert.equal(context.truncated, false);
  assert.match(context.markdown, /先保留失败现场/);
  assert.match(context.markdown, /这个结论不对/);
  assert.match(context.markdown, /Triage evidence: yes/);
  assert.doesNotMatch(context.markdown, /不属于当前 Experience/);

  const limited = buildExperienceContext(home, record, 1);
  assert.equal(limited.records.length, 1);
  assert.equal(limited.totalRecords, 2);
  assert.equal(limited.truncated, true);

  assert.throws(
    () => buildExperienceContext(home, { ...record, sourceRecordIds: [...record.sourceRecordIds, "missing-record"] }),
    /could not resolve Source records: missing-record/,
  );
});

test("Experience context materializes one immutable Artifact and one produced lineage link per Run", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-context-artifact-"));
  const home = join(sandbox, "ikb-data");
  const { record } = fixture(home, sandbox);
  const store = new LedgerStore({ home });
  const task = store.createTask({ title: "分析经验", goal: "读取精确证据", acceptance: "形成证据包", scope: "work" });
  const run = store.createRun(task.id, "ikb-analyst", ["ikb-conversation-analysis"]);

  const first = materializeExperienceContext(home, store, record, run.id);
  const second = materializeExperienceContext(home, store, record, run.id);
  assert.equal(first.contextArtifact.id, second.contextArtifact.id);
  assert.match(first.contextArtifact.path, /experience-exp-context-fixture-context-[a-f0-9]{16}\.md$/);
  assert.equal(existsSync(first.contextArtifact.path), true);
  assert.equal(readFileSync(first.contextArtifact.path, "utf8"), first.markdown);
  assert.equal(store.listArtifacts({ runId: run.id }).filter((item) => item.kind === "experience-context").length, 1);
  assert.equal(store.listEvents().filter((event) => event.aggregateId === run.id && event.eventType === "run.artifact_linked" && event.payload.artifactId === first.contextArtifact.id).length, 1);
  assert.equal(store.listEvents().filter((event) => event.aggregateId === record.id && event.eventType === "experience.context_built" && event.payload.artifactId === first.contextArtifact.id).length, 1);
  assert.equal(store.listEvents().filter((event) => event.eventType === "source.context_built" && event.payload.artifactId === first.contextArtifact.id).length, 1);

  const personalTask = store.createTask({ title: "错误范围", goal: "不应读取", acceptance: "阻止", scope: "personal" });
  const personalRun = store.createRun(personalTask.id, "ikb-analyst", ["ikb-conversation-analysis"]);
  assert.throws(() => materializeExperienceContext(home, store, record, personalRun.id), /does not match Experience scope work/);
  store.close();
});

test("Experience context expands event-backed Knowledge feedback into controlled Run and Artifact metadata", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-context-feedback-"));
  const home = join(sandbox, "ikb-data");
  const consumerResult = join(sandbox, "consumer-result.md");
  writeFileSync(consumerResult, "# Sensitive consumer body\n\nThis body stays in the registered Artifact.\n");
  const store = new LedgerStore({ home });
  const knowledge = captureKnowledge(home, {
    title: "技术方案评审结构",
    scope: "work",
    body: "按目标、事实、方案和验证组织评审。",
  });
  const consumerTask = store.createTask({ title: "文档重写", goal: "重写", acceptance: "可读", scope: "work" });
  const consumerRun = store.createRun(consumerTask.id, "ikb-operator", ["ikb-use-knowledge"]);
  const evidenceArtifact = store.createArtifact({ runId: consumerRun.id, path: consumerResult, kind: "canary-result", label: "consumer result" });
  const feedback = store.recordKnowledgeEvent(knowledge.id, "knowledge.feedback_recorded", {
    taskId: consumerTask.id,
    runId: consumerRun.id,
    outcome: "partial",
    reasonCode: "rewrite_method_missing",
    note: "结构可用，但缺少整篇重写方法。",
    evidenceRefs: [evidenceArtifact.id],
  });
  const record: ExperienceRecord = {
    schema: EXPERIENCE_VERSION,
    id: "exp-feedback-context",
    scope: "work",
    adapter: null,
    sourceTitle: `Knowledge feedback：${knowledge.title}`,
    sourceIds: [],
    sourceOriginHash: "a".repeat(64),
    sessionKeyHash: "b".repeat(64),
    conversationIdHash: "c".repeat(64),
    sourceRecordIds: [],
    evidenceRecordIds: [],
    evidenceEventIds: [feedback.eventId],
    runIds: [consumerRun.id],
    validationRefs: [],
    signalCodes: ["knowledge_feedback"],
    signalCounts: { failure_or_block: 0, retry: 0, manual_correction: 0, verifier_rejection: 0, non_obvious_fix: 0, knowledge_feedback: 1, decision_or_rule: 0 },
    triageDisposition: "selected",
    status: "queued",
    firstSeenAt: feedback.occurredAt,
    lastSeenAt: feedback.occurredAt,
    createdAt: feedback.occurredAt,
    updatedAt: feedback.occurredAt,
  };
  const analystTask = store.createTask({ title: "分析反馈", goal: "判断处置", acceptance: "证据可回放", scope: "work" });
  const analystRun = store.createRun(analystTask.id, "ikb-analyst", ["ikb-conversation-analysis"]);

  const context = materializeExperienceContext(home, store, record, analystRun.id);
  assert.equal(context.records.length, 0);
  assert.equal(context.events.length, 1);
  assert.equal(context.events[0].outcome, "partial");
  assert.equal(context.events[0].reasonCode, "rewrite_method_missing");
  assert.deepEqual(context.events[0].artifactIds, [evidenceArtifact.id]);
  assert.equal(context.artifacts[0].contentHash, evidenceArtifact.contentHash);
  assert.equal(context.knowledgeTargets[0].id, knowledge.id);
  assert.match(context.markdown, /结构可用，但缺少整篇重写方法/);
  assert.match(context.markdown, new RegExp(evidenceArtifact.id));
  assert.doesNotMatch(context.markdown, /Sensitive consumer body/);
  const built = store.listEvents().find((event) => event.aggregateId === record.id && event.eventType === "experience.context_built");
  assert.deepEqual(built?.payload.evidenceEventIds, [feedback.eventId]);
  assert.deepEqual(built?.payload.artifactIds, [evidenceArtifact.id]);
  store.close();
});

test("Experience context groups mirrored history imports without losing raw record references", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-context-mirrors-"));
  const home = join(sandbox, "ikb-data");
  const path = join(sandbox, "mirrored-session.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "mirror", messageId: "u1", timestamp: "2026-08-01T10:00:00Z", content: "这条消息被两个历史入口发现。" }),
    JSON.stringify({ role: "assistant", conversationId: "mirror", messageId: "a1", timestamp: "2026-08-01T10:01:00Z", content: "正文只应该分析一次。" }),
  ].join("\n") + "\n");
  const first = importSource(home, path, { kind: "ai_conversation", adapter: "codex", scope: "work" });
  const second = importSource(home, path, { kind: "ai_conversation", adapter: "codex", scope: "work" });
  const record: ExperienceRecord = {
    schema: EXPERIENCE_VERSION,
    id: "exp-mirrored-fixture",
    scope: "work",
    adapter: "codex",
    sourceTitle: "镜像入口测试",
    sourceIds: [first.source.id, second.source.id],
    sourceOriginHash: "d".repeat(64),
    sessionKeyHash: "e".repeat(64),
    conversationIdHash: "f".repeat(64),
    sourceRecordIds: [...first.records.map((item) => item.id), ...second.records.map((item) => item.id)],
    evidenceRecordIds: [second.records[0].id],
    evidenceEventIds: [],
    runIds: [],
    validationRefs: [],
    signalCodes: ["manual_correction"],
    signalCounts: { failure_or_block: 0, retry: 0, manual_correction: 1, verifier_rejection: 0, non_obvious_fix: 0, knowledge_feedback: 0, decision_or_rule: 0 },
    triageDisposition: "selected",
    status: "queued",
    firstSeenAt: "2026-08-01T10:00:00Z",
    lastSeenAt: "2026-08-01T10:01:00Z",
    createdAt: "2026-08-01T10:02:00Z",
    updatedAt: "2026-08-01T10:02:00Z",
  };

  const context = buildExperienceContext(home, record);
  assert.equal(context.sourceRecordCount, 4);
  assert.equal(context.totalRecords, 2);
  assert.equal(context.records.length, 2);
  assert.equal(context.records[0].triageEvidence, true);
  assert.deepEqual(context.records[0].equivalentRecordIds, [first.records[0].id, second.records[0].id]);
  assert.deepEqual(context.records[0].equivalentSourceIds, [first.source.id, second.source.id]);
  assert.equal(context.markdown.match(/这条消息被两个历史入口发现。/g)?.length, 1);
  assert.match(context.markdown, new RegExp(first.records[0].id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(context.markdown, new RegExp(second.records[0].id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
