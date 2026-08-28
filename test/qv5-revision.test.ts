import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as knowledgeApi from "../src/knowledge.ts";
import { applyReviewedQv5KnowledgeRevision, captureKnowledge, findKnowledge, preflightReviewedQv5KnowledgeRevision, searchKnowledge } from "../src/knowledge.ts";
import { findExperienceCandidate } from "../src/experience.ts";
import { LedgerStore } from "../src/store.ts";
import { createQv5Fixture } from "./qv5-fixture.ts";

type Qv5CorrectionHoldResolutionInput = { candidateId: string; revisionId: string };
type Qv5CorrectionHoldResolutionResult = { outcome: "updated" | "unchanged"; candidate: { id: string; status: string } };

// The production seam is intentionally absent at this checkpoint; keeping it
// behind a runtime cast makes the red tests execute and name the missing API.
const resolveQv5KnowledgeCorrectionHold = (knowledgeApi as unknown as {
  resolveQv5KnowledgeCorrectionHold: (home: string, store: LedgerStore, input: Qv5CorrectionHoldResolutionInput) => Qv5CorrectionHoldResolutionResult;
}).resolveQv5KnowledgeCorrectionHold;

function writeQv5CorrectionCandidate(home: string, input: {
  id: string;
  targetKnowledgeIds: string[];
  replacementPath: string;
  status?: "pending_review" | "accepted";
  scope?: "work" | "personal";
}): void {
  const status = input.status ?? "accepted";
  const replacement = readFileSync(input.replacementPath, "utf8");
  const reviewedHash = createHash("sha256").update(replacement).digest("hex");
  const reviewedRef = `experiences/reviews/${input.id}/${reviewedHash}.md`;
  mkdirSync(join(home, "experiences", "candidates"), { recursive: true });
  mkdirSync(join(home, "experiences", "reviews", input.id), { recursive: true });
  writeFileSync(join(home, reviewedRef), replacement, { mode: 0o600 });
  const candidate = {
    schema: "ikb-knowledge-candidate.v1",
    id: input.id,
    scope: input.scope ?? "work",
    status,
    contentHash: "b".repeat(64),
    title: "待复核知识修订：QV5 P0 hold",
    patternKey: "qv5.p0.hold",
    signalCodes: ["manual_correction"],
    analysisIds: ["exp-analysis-qv5"],
    patternLabel: "QV5 P0 hold",
    claimVariants: ["旧规则需要在修订前隔离。"],
    changeTypes: ["revise"],
    targetKnowledgeIds: input.targetKnowledgeIds,
    experienceIds: ["exp-qv5"],
    sourceIds: ["src-qv5"],
    sourceRecordRefs: ["src-qv5:r1"],
    evidenceEventIds: [],
    runIds: ["run-qv5"],
    validationRefs: [],
    independentRunCount: 1,
    independentSourceCount: 1,
    humanApprovalRequired: true,
    candidateKnowledge: {
      claim: "旧规则需要在修订前隔离。",
      type: "playbook",
      collection: "playbooks",
      requiredSections: ["claim", "evidence", "applicability", "boundary", "use contract", "validation plan"],
      evidenceRefs: ["src-qv5:r1"],
      applicability: "存在 P0 反例时。",
      boundary: "只解除已完成的 QV5 修订。",
      useContract: "P0 修订评审。",
      validationPlan: "验证 Context hold。",
      confidence: "unknown",
      temporalState: "unknown",
    },
    ...(status === "accepted" ? {
      decision: {
        outcome: "accepted",
        reason: "已审完整 QV5 replacement。",
        candidateContentHash: "b".repeat(64),
        reviewedArtifact: { sourceRef: reviewedRef, ref: reviewedRef, contentHash: reviewedHash },
        decidedAt: "2026-08-18T00:00:00Z",
      },
      nextAction: "curate_accepted_candidate_and_apply",
    } : { nextAction: "curator_review_evidence_and_publish_or_reject" }),
    createdAt: "2026-08-18T00:00:00Z",
    updatedAt: "2026-08-18T00:00:00Z",
  };
  writeFileSync(join(home, "experiences", "candidates", `${input.id}.json`), `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
}

function assertStillHeld(home: string, candidateId: string, knowledgeId: string): void {
  assert.notEqual(findExperienceCandidate(home, candidateId)?.status, "applied");
  assert.equal(searchKnowledge(home, "有界重试", { scope: "work" }).some((item) => item.id === knowledgeId), false);
}
test("QV5 direct revision accepts split valid V3 analyst/curator artifacts idempotently", () => { const home = mkdtempSync(join(tmpdir(), "qv5-")); const store = new LedgerStore({ home }); const fx = createQv5Fixture(home, store); applyReviewedQv5KnowledgeRevision(home, store, fx.input); applyReviewedQv5KnowledgeRevision(home, store, fx.input); assert.equal(findKnowledge(home, fx.target.id)?.revision, 2); assert.equal(store.listEvents().filter((e) => e.eventType === "knowledge.revised").length, 1); store.close(); });

function rejects(input: any, message: RegExp, options?: any): void { const home = mkdtempSync(join(tmpdir(), "qv5-")); const store = new LedgerStore({ home }); const fx = createQv5Fixture(home, store, "rule", options); assert.throws(() => preflightReviewedQv5KnowledgeRevision(home, store, input(fx, store)), message); store.close(); }
test("QV5 rejects replacement and validation from different Curator Runs", () => rejects((fx: any, store: LedgerStore) => ({ ...fx.input, validationArtifactId: createQv5Fixture(store.home, store, "other").input.validationArtifactId }), /replacement and validation/));
test("QV5 rejects split Analyst artifact group", () => rejects((fx: any, store: LedgerStore) => ({ ...fx.input, compilationArtifactId: createQv5Fixture(store.home, store, "other").input.compilationArtifactId }), /manifest, compilation and fidelity/));
test("QV5 rejects a same Analyst and Curator Run", () => rejects((fx: any, store: LedgerStore) => { const replacement = store.createArtifact({ runId: fx.analyst.id, kind: "knowledge-qv5-replacement-draft", label: "x", path: store.requireArtifact(fx.input.replacementArtifactId).path }); const validation = store.createArtifact({ runId: fx.analyst.id, kind: "knowledge-qv5-validation", label: "x", path: store.requireArtifact(fx.input.validationArtifactId).path }); return { ...fx.input, replacementArtifactId: replacement.id, validationArtifactId: validation.id }; }, /must be different Runs/));
test("QV5 rejects missing Curator or Analyst skill and scope mismatch", () => { rejects((fx: any) => fx.input, /Curator Run/, { curatorSkills: ["other"] }); rejects((fx: any) => fx.input, /Analyst Run/, { analystSkills: ["other"] }); rejects((fx: any) => fx.input, /scope/, { analystScope: "personal" }); });
test("QV5 rejects tampered artifact bytes and a stored fidelity mismatch", () => { rejects((fx: any, store: LedgerStore) => { writeFileSync(store.requireArtifact(fx.input.replacementArtifactId).path, "tampered"); return fx.input; }, /Artifact bytes changed/); rejects((fx: any, store: LedgerStore) => { writeFileSync(fx.paths.fidelity, "{}"); const fidelity = store.createArtifact({ runId: fx.analyst.id, kind: "knowledge-extraction-fidelity", label: "x", path: fx.paths.fidelity }); const replacementPath = `${fx.paths.replacement}.fidelity`; const replacementText = readFileSync(fx.paths.replacement, "utf8").replace(fx.input.fidelityArtifactId, fidelity.id); writeFileSync(replacementPath, replacementText); const replacement = store.createArtifact({ runId: fx.curator.id, kind: "knowledge-qv5-replacement-draft", label: "x", path: replacementPath }); const validationPath = `${replacementPath}.validation`; writeFileSync(validationPath, JSON.stringify({ knowledgeId: fx.target.id, bodyExact: true, renderedHash: createHash("sha256").update(replacementText).digest("hex") })); const validation = store.createArtifact({ runId: fx.curator.id, kind: "knowledge-qv5-validation", label: "x", path: validationPath }); return { ...fx.input, replacementArtifactId: replacement.id, validationArtifactId: validation.id, fidelityArtifactId: fidelity.id }; }, /stored information loss/); });
test("QV5 rejects a replacement whose validation hash matches but body is non-deterministic", () => rejects((fx: any, store: LedgerStore) => { const path = fx.paths.replacement; const value = readFileSync(path, "utf8").replace(/## 使用定位/, "short body\n\n## 使用定位"); writeFileSync(path, value); const replacement = store.createArtifact({ runId: fx.curator.id, kind: "knowledge-qv5-replacement-draft", label: "bad", path }); const validationPath = `${path}.validation`; writeFileSync(validationPath, JSON.stringify({ knowledgeId: fx.target.id, bodyExact: true, renderedHash: createHash("sha256").update(value).digest("hex") })); const validation = store.createArtifact({ runId: fx.curator.id, kind: "knowledge-qv5-validation", label: "bad", path: validationPath }); return { ...fx.input, replacementArtifactId: replacement.id, validationArtifactId: validation.id }; }, /body does not exactly/));

test("QV5 correction hold resolves only after the completed exact revision", () => {
  const home = mkdtempSync(join(tmpdir(), "qv5-hold-resolve-"));
  const store = new LedgerStore({ home });
  const fx = createQv5Fixture(home, store);
  const candidateId = "exp-cand-qv5holdsuccess";
  writeQv5CorrectionCandidate(home, { id: candidateId, targetKnowledgeIds: [fx.target.id], replacementPath: fx.paths.replacement });
  assertStillHeld(home, candidateId, fx.target.id);
  const revision = applyReviewedQv5KnowledgeRevision(home, store, fx.input);
  assert.equal(revision.journal.status, "completed");
  assertStillHeld(home, candidateId, fx.target.id);

  const resolved = resolveQv5KnowledgeCorrectionHold(home, store, { candidateId, revisionId: revision.journal.id });

  assert.equal(resolved.outcome, "updated");
  assert.equal(resolved.candidate.status, "applied");
  assert.equal(findExperienceCandidate(home, candidateId)?.status, "applied");
  assert.equal(searchKnowledge(home, "有界重试", { scope: "work" }).some((item) => item.id === fx.target.id), true);
  store.close();
});

test("QV5 correction hold rejects a non-accepted Candidate and keeps it held", () => {
  const home = mkdtempSync(join(tmpdir(), "qv5-hold-pending-"));
  const store = new LedgerStore({ home });
  const fx = createQv5Fixture(home, store);
  const candidateId = "exp-cand-qv5holdpending";
  writeQv5CorrectionCandidate(home, { id: candidateId, targetKnowledgeIds: [fx.target.id], replacementPath: fx.paths.replacement, status: "pending_review" });
  const revision = applyReviewedQv5KnowledgeRevision(home, store, fx.input);

  assert.throws(() => resolveQv5KnowledgeCorrectionHold(home, store, { candidateId, revisionId: revision.journal.id }), /accepted/i);
  assertStillHeld(home, candidateId, fx.target.id);
  store.close();
});

test("QV5 correction hold rejects a Candidate whose target does not match the journal and keeps its target held", () => {
  const home = mkdtempSync(join(tmpdir(), "qv5-hold-target-"));
  const store = new LedgerStore({ home });
  const fx = createQv5Fixture(home, store);
  const other = captureKnowledge(home, { title: "另一条 P0 规则", scope: "work", status: "draft", sourceRefs: ["manual:test"], body: "另一条旧规则。" });
  const candidateId = "exp-cand-qv5holdtarget";
  writeQv5CorrectionCandidate(home, { id: candidateId, targetKnowledgeIds: [other.id], replacementPath: fx.paths.replacement });
  const revision = applyReviewedQv5KnowledgeRevision(home, store, fx.input);

  assert.throws(() => resolveQv5KnowledgeCorrectionHold(home, store, { candidateId, revisionId: revision.journal.id }), /target/i);
  assert.notEqual(findExperienceCandidate(home, candidateId)?.status, "applied");
  assert.equal(searchKnowledge(home, "另一条 P0 规则", { scope: "work" }).some((item) => item.id === other.id), false);
  store.close();
});

test("QV5 correction hold rejects a Candidate whose scope does not match the journal and keeps it held", () => {
  const home = mkdtempSync(join(tmpdir(), "qv5-hold-scope-"));
  const store = new LedgerStore({ home });
  const fx = createQv5Fixture(home, store);
  const candidateId = "exp-cand-qv5holdscope";
  writeQv5CorrectionCandidate(home, { id: candidateId, targetKnowledgeIds: [fx.target.id], replacementPath: fx.paths.replacement, scope: "personal" });
  const revision = applyReviewedQv5KnowledgeRevision(home, store, fx.input);

  assert.throws(() => resolveQv5KnowledgeCorrectionHold(home, store, { candidateId, revisionId: revision.journal.id }), /scope/i);
  assertStillHeld(home, candidateId, fx.target.id);
  store.close();
});

test("QV5 correction hold rejects a reviewed replacement whose hash differs from the journal replacement", () => {
  const home = mkdtempSync(join(tmpdir(), "qv5-hold-hash-"));
  const store = new LedgerStore({ home });
  const fx = createQv5Fixture(home, store);
  const reviewedPath = join(home, "different-reviewed-replacement.md");
  writeFileSync(reviewedPath, `${readFileSync(fx.paths.replacement, "utf8")}\n未经审计的改动。\n`);
  const candidateId = "exp-cand-qv5holdhash";
  writeQv5CorrectionCandidate(home, { id: candidateId, targetKnowledgeIds: [fx.target.id], replacementPath: reviewedPath });
  const revision = applyReviewedQv5KnowledgeRevision(home, store, fx.input);

  assert.throws(() => resolveQv5KnowledgeCorrectionHold(home, store, { candidateId, revisionId: revision.journal.id }), /hash/i);
  assertStillHeld(home, candidateId, fx.target.id);
  store.close();
});

test("QV5 correction hold rejects a journal that is not completed and keeps it held", () => {
  const home = mkdtempSync(join(tmpdir(), "qv5-hold-prepared-"));
  const store = new LedgerStore({ home });
  const fx = createQv5Fixture(home, store);
  const candidateId = "exp-cand-qv5holdprepared";
  writeQv5CorrectionCandidate(home, { id: candidateId, targetKnowledgeIds: [fx.target.id], replacementPath: fx.paths.replacement });
  const revision = applyReviewedQv5KnowledgeRevision(home, store, fx.input);
  const journalPath = join(home, "revisions", "knowledge", "work", revision.journal.id, "journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.status = "prepared";
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  assert.throws(() => resolveQv5KnowledgeCorrectionHold(home, store, { candidateId, revisionId: revision.journal.id }), /completed/i);
  assertStillHeld(home, candidateId, fx.target.id);
  store.close();
});

test("QV5 correction hold rejects a current card that no longer matches the after snapshot and keeps it held", () => {
  const home = mkdtempSync(join(tmpdir(), "qv5-hold-current-"));
  const store = new LedgerStore({ home });
  const fx = createQv5Fixture(home, store);
  const candidateId = "exp-cand-qv5holdcurrent";
  writeQv5CorrectionCandidate(home, { id: candidateId, targetKnowledgeIds: [fx.target.id], replacementPath: fx.paths.replacement });
  const revision = applyReviewedQv5KnowledgeRevision(home, store, fx.input);
  writeFileSync(fx.target.path, `${readFileSync(fx.target.path, "utf8")}\n并发手工修改。\n`);

  assert.throws(() => resolveQv5KnowledgeCorrectionHold(home, store, { candidateId, revisionId: revision.journal.id }), /after.*hash|current.*hash|current.*after/i);
  assertStillHeld(home, candidateId, fx.target.id);
  store.close();
});
