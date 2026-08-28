import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { findInboxItem, upsertInboxItem } from "../src/inbox.ts";
import { captureKnowledge, findKnowledge, listKnowledge } from "../src/knowledge.ts";
import { applySemanticMaintenance } from "../src/semantic-maintenance.ts";
import { LedgerStore } from "../src/store.ts";

test("semantic maintenance installs one bounded draft and archives its Inbox item", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-semantic-new-"));
  const templateHome = join(home, "template");
  const draft = captureKnowledge(templateHome, {
    title: "Semantic maintenance fact",
    body: "A bounded fact produced from one preserved Source.",
    scope: "work",
    sourceKind: "document",
    sourceRefs: ["src-semantic-fact"],
    admissionReason: "Future tasks need the bounded fact",
    applicability: "Semantic maintenance contract tests",
    boundary: "Synthetic fixture only",
  });
  const inbox = upsertInboxItem(home, {
    scope: "work",
    trigger: "source_changed",
    subject: draft.title,
    goal: "Create one bounded fact for a known consumer",
    sourceRefs: ["src-semantic-fact"],
    knowledgeIds: [],
    usageId: null,
    details: {},
  });
  const store = new LedgerStore({ home });
  const result = applySemanticMaintenance(home, store, {
    schema: "ikb-semantic-maintenance.v1",
    scope: "work",
    decisions: [{
      inboxId: inbox.id,
      action: "new",
      replacementPath: draft.path,
      reason: "Source and consumer boundary are complete",
      validation: { status: "passed", checks: ["Source ref", "applicability", "boundary"], issues: [] },
    }],
  });
  assert.equal(result.changed, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(findKnowledge(home, draft.id)?.status, "draft");
  assert.equal(findInboxItem(home, inbox.id), null);
  assert.equal(existsSync(join(home, "archive", "inbox", "work", `${inbox.id}.json`)), true);
  assert.equal(receiptCount(home), 1);
  assert.equal(result.receipt.operations[0].action, "new");
  assert.equal(result.receipt.operations[0].inputRefs.includes(draft.path), true);
  assert.equal(result.confirmationBrief, null);

  const existing = findKnowledge(home, draft.id)!;
  const updatePath = join(templateHome, "semantic-maintenance-fact-update.md");
  writeFileSync(updatePath, readFileSync(existing.path, "utf8").replace("one preserved Source", "one preserved and reviewed Source"));
  const updateInbox = upsertInboxItem(home, {
    scope: "work",
    trigger: "source_changed",
    subject: existing.title,
    goal: "Update the bounded fact from its reviewed replacement",
    sourceRefs: ["src-semantic-fact"],
    knowledgeIds: [existing.id],
    usageId: null,
    details: {},
  });
  const update = applySemanticMaintenance(home, store, {
    schema: "ikb-semantic-maintenance.v1",
    scope: "work",
    decisions: [{
      inboxId: updateInbox.id,
      action: "update",
      knowledgeId: existing.id,
      replacementPath: updatePath,
      reason: "Reviewed replacement preserves the existing knowledge identity",
      validation: { status: "passed", checks: ["identity", "source"], issues: [] },
    }],
  });
  assert.equal(update.receipt.operations[0].inputRefs.includes(updatePath), true);
  store.close();
});

test("semantic maintenance leaves an unconfirmed Principle as a diff", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-semantic-principle-"));
  const templateHome = join(home, "template");
  const principle = captureKnowledge(templateHome, {
    title: "Unconfirmed exact Principle",
    body: "Only a human may confirm this exact Principle text.",
    type: "principle",
    scope: "work",
    status: "draft",
    sourceKind: "document",
    sourceRefs: ["src-principle-diff"],
    qualityVersion: 5,
    productType: "principle_card",
    canonicalKey: "work:principle:unconfirmed-exact-principle",
    compilationSchema: "ikb-knowledge-compilation-result.v3",
    compilationCaseId: "case-principle-diff",
    compilationProductId: "product-principle-diff",
    extractionManifestRef: "artifact-manifest-principle-diff",
    compilationRef: "artifact-compilation-principle-diff",
    informationLossRef: "artifact-fidelity-principle-diff",
    factRefs: ["fact-principle-diff"],
    questionsAnswered: ["Which exact Principle text is proposed?"],
    admissionReason: "A future Agent judgment would depend on the exact text",
    applicability: "Only after explicit human confirmation",
    boundary: "No automatic activation or AGENTS projection",
    confidenceBasis: ["Preserved Source only; human confirmation pending"],
  });
  const inbox = upsertInboxItem(home, {
    scope: "work",
    trigger: "principle_confirmation",
    subject: principle.title,
    goal: "Review the exact Principle text and exceptions",
    sourceRefs: ["src-principle-diff"],
    knowledgeIds: [],
    usageId: null,
    details: {},
  });
  const secondPath = join(dirname(principle.path), "second-principle.md");
  writeFileSync(secondPath, readFileSync(principle.path, "utf8")
    .replace(`id: ${principle.id}`, "id: kb-second-unconfirmed-principle")
    .replace("title: Unconfirmed exact Principle", "title: Second unconfirmed exact Principle")
    .replace("canonical_key: work:principle:unconfirmed-exact-principle", "canonical_key: work:principle:second-unconfirmed-exact-principle"));
  const secondInbox = upsertInboxItem(home, {
    scope: "work",
    trigger: "principle_confirmation",
    subject: "Second unconfirmed exact Principle",
    goal: "Review the second exact Principle text and exceptions",
    sourceRefs: ["src-principle-diff"],
    knowledgeIds: [],
    usageId: null,
    details: {},
  });
  const store = new LedgerStore({ home });
  const result = applySemanticMaintenance(home, store, {
    schema: "ikb-semantic-maintenance.v1",
    scope: "work",
    decisions: [{
      inboxId: inbox.id,
      action: "new",
      replacementPath: principle.path,
      reason: "Prepare a reviewable diff without confirming it",
      validation: { status: "passed", checks: ["Source ref", "exact draft"], issues: [] },
    }, {
      inboxId: secondInbox.id,
      action: "new",
      replacementPath: secondPath,
      reason: "Prepare the second reviewable diff without confirming it",
      validation: { status: "passed", checks: ["Source ref", "exact draft"], issues: [] },
    }],
  });
  assert.equal(result.changed, 0);
  assert.equal(result.pendingPrinciples, 2);
  assert.equal(result.confirmationBrief?.itemCount, 2);
  assert.match(readFileSync(result.confirmationBrief!.path, "utf8"), /Only a human may confirm this exact Principle text/);
  assert.match(readFileSync(result.confirmationBrief!.path, "utf8"), /确认：A、B/);
  assert.equal(listKnowledge(home).length, 0);
  assert.ok(findInboxItem(home, inbox.id));
  assert.equal(result.receipt.operations[0].action, "principle_diff");
  assert.equal(result.receipt.operations[0].outcome, "pending_confirmation");
  store.close();
});

function receiptCount(home: string): number {
  const directory = join(home, ".system", "receipts");
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".json")).length : 0;
}
