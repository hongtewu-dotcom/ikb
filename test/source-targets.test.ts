import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeSourceTargets, listSourceTargets, sourceTargetRegistryPath } from "../src/source-targets.ts";

test("source target initialization creates local inboxes and migrates the old document placeholder", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-targets-"));
  const path = sourceTargetRegistryPath(home);
  initializeSourceTargets(home);
  const initial = JSON.parse(readFileSync(path, "utf8"));
  const document = initial.targets.find((target: { id: string }) => target.id === "important-documents");
  assert.equal(document.kind, "local_directory");
  assert.equal(document.sourceKind, "document");
  assert.equal(existsSync(document.locator.path), true);
  assert.equal(existsSync(join(home, "inbox", "work", "review-comments")), true);
  assert.equal(listSourceTargets(home, "personal").length, 2);

  writeFileSync(path, `${JSON.stringify({
    schema: "ikb-source-target-registry.v1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    policies: { elephant: { readOnly: true } },
    targets: [
      { id: "important-documents", adapter: "local-document", kind: "document_registry", scope: "work", enabled: true, status: "needs_explicit_path_registry" },
      { id: "custom-elephant", adapter: "elephant", kind: "group", scope: "work", enabled: true, locator: { gid: "123" } },
    ],
  }, null, 2)}\n`);
  const migrated = initializeSourceTargets(home);
  const migratedDocument = migrated.targets.find((target) => target.id === "important-documents")!;
  assert.equal(migratedDocument.kind, "local_directory");
  assert.equal(migratedDocument.status, "active");
  assert.equal(Boolean(migratedDocument.locator?.path), true);
  assert.equal(migrated.targets.some((target) => target.id === "custom-elephant"), true);
  assert.deepEqual(migrated.policies, { elephant: { readOnly: true } });
});
