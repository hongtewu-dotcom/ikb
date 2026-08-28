import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeReceipt, type ReceiptOperation } from "../src/receipt.ts";
import { LedgerStore } from "../src/store.ts";

test("the single Receipt writer persists one immutable operations array", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-receipt-"));
  const store = new LedgerStore({ home });
  const legacyArtifact = join(home, "legacy-qv5-artifact.json");
  writeFileSync(legacyArtifact, "{\"legacy\":true}\n");
  const beforeLegacy = readFileSync(legacyArtifact, "utf8");
  const operations: ReceiptOperation[] = [
    knowledgeOperation("new", "kb-new", null, "after-new"),
    knowledgeOperation("update", "kb-update", "before-update", "after-update"),
    knowledgeOperation("retire", "kb-retire", "before-retire", "after-retire"),
  ];

  const receipt = writeReceipt(home, store, {
    kind: "knowledge_maintenance",
    scope: "work",
    command: "semantic-maintenance",
    startedAt: "2026-08-27T10:30:00.000Z",
    finishedAt: "2026-08-27T10:30:01.000Z",
    outcome: "succeeded",
    operations,
  });
  assert.equal(existsSync(receipt.path), true);
  const persisted = JSON.parse(readFileSync(receipt.path, "utf8"));
  assert.equal(persisted.schema, "ikb-receipt.v1");
  assert.equal(persisted.operations.length, 3);
  assert.deepEqual(persisted.operations.map((operation: { action: string }) => operation.action), ["new", "update", "retire"]);
  assert.equal(readFileSync(legacyArtifact, "utf8"), beforeLegacy);
  const events = store.listEvents().filter((event) => event.eventType === "receipt.written");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.operationCount, 3);
  store.close();
});

test("Knowledge-changing Receipt operations require replay evidence", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-receipt-invalid-"));
  const store = new LedgerStore({ home });
  assert.throws(() => writeReceipt(home, store, {
    kind: "knowledge_maintenance",
    scope: "work",
    command: "semantic-maintenance",
    startedAt: new Date().toISOString(),
    outcome: "failed",
    operations: [{
      action: "update",
      subjectRef: "knowledge://kb-missing-evidence",
      inputRefs: [],
      outputRefs: [],
      sourceRefs: [],
      beforeHash: null,
      afterHash: null,
      applicability: null,
      boundary: null,
      validation: { status: "failed", checks: [], issues: ["missing evidence"] },
      outcome: "blocked",
      confirmation: null,
    }],
  }), /requires Source refs/);
  assert.equal(store.listEvents().some((event) => event.eventType === "receipt.written"), false);
  store.close();
});

function knowledgeOperation(action: "new" | "update" | "retire", id: string, beforeHash: string | null, afterHash: string): ReceiptOperation {
  return {
    action,
    subjectRef: `knowledge://${id}`,
    inputRefs: ["source://src-receipt-test"],
    outputRefs: [`knowledge://${id}`],
    sourceRefs: ["src-receipt-test"],
    beforeHash,
    afterHash,
    applicability: "Receipt contract test",
    boundary: "Synthetic fixture",
    validation: { status: "passed", checks: ["source refs", "hashes", "boundary"], issues: [] },
    outcome: "changed",
    confirmation: null,
  };
}
