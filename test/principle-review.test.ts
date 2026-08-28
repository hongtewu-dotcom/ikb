import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { findInboxItem } from "../src/inbox.ts";
import { captureKnowledge } from "../src/knowledge.ts";
import { scanPrincipleConfirmationConflicts } from "../src/principle-review.ts";
import { LedgerStore } from "../src/store.ts";

test("Principle conflict scan writes an exact proposal without changing Knowledge", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-principle-review-"));
  const principle = captureKnowledge(home, {
    title: "Exact Principle review fixture",
    body: [
      "# Exact Principle review fixture",
      "",
      "#### statement",
      "Keep the exact body reviewable.",
      "",
      "#### 边界",
      "- 当前产物是 pending_review Principle 候选，未获用户逐项确认前不得进入默认检索。",
    ].join("\n"),
    type: "principle",
    scope: "work",
    sourceKind: "document",
    sourceRefs: ["src-principle-review"],
    qualityVersion: 5,
    productType: "principle_card",
    canonicalKey: "work:principle:exact-review-fixture",
    compilationSchema: "ikb-knowledge-compilation-result.v3",
    compilationCaseId: "case-exact-review",
    compilationProductId: "product-exact-review",
    extractionManifestRef: "artifact-manifest-exact-review",
    compilationRef: "artifact-compilation-exact-review",
    informationLossRef: "artifact-fidelity-exact-review",
    factRefs: ["fact-exact-review"],
    questionsAnswered: ["Which exact bytes require confirmation?"],
    admissionReason: "The runtime status depends on exact confirmation",
    applicability: "Principle confirmation conflict tests",
    boundary: "No automatic Knowledge or AGENTS mutation",
    confidenceBasis: ["Synthetic Source fixture"],
  });
  const current = readFileSync(principle.path, "utf8")
    .replace("status: draft", "status: verified")
    .replace("verification: unverified", "verification: user_confirmed");
  writeFileSync(principle.path, current);
  for (const suffix of ["b", "c"]) {
    const id = `kb-principle-review-${suffix}`;
    writeFileSync(join(dirname(principle.path), `${id}.md`), current
      .replace(`id: ${principle.id}`, `id: ${id}`)
      .replace("title: Exact Principle review fixture", `title: Exact Principle review fixture ${suffix}`)
      .replace("canonical_key: work:principle:exact-review-fixture", `canonical_key: work:principle:exact-review-fixture-${suffix}`));
  }
  const beforeHash = hash(current);
  const store = new LedgerStore({ home });

  const result = scanPrincipleConfirmationConflicts(home, store, "work", 3);
  assert.equal(result.conflicts, 3);
  assert.equal(result.confirmationBrief?.itemCount, 3);
  const brief = readFileSync(result.confirmationBrief!.path, "utf8");
  assert.match(brief, /Keep the exact body reviewable\./);
  assert.match(brief, /确认：A、B、C/);
  assert.ok(brief.indexOf(reviewHashMarker(result.reviews[0].proposedHash)) > brief.indexOf("附录"));
  assert.equal(hash(readFileSync(principle.path, "utf8")), beforeHash);
  const review = result.reviews[0];
  const proposed = readFileSync(review.proposedPath, "utf8");
  assert.equal(proposed.includes("pending_review Principle 候选"), false);
  assert.equal(proposed, current.replace("- 当前产物是 pending_review Principle 候选，未获用户逐项确认前不得进入默认检索。\n", ""));
  assert.equal(review.proposedHash, hash(proposed));
  assert.ok(findInboxItem(home, review.inboxId));
  assert.equal(result.receipt.operations[0].outcome, "pending_confirmation");
  assert.equal(store.listEvents().filter((event) => event.eventType === "receipt.written").length, 1);
  assert.equal(store.listEvents().some((event) => event.eventType === "knowledge.revised"), false);
  store.close();
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reviewHashMarker(hashValue: string): string {
  return `Proposal hash: ${hashValue}`;
}
