import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildSourceContext, findSource, importSource, importSourceRecords, inspectSourceIntegrity, inspectSourceRegistry, listSources, readSourceRecords } from "../src/source.ts";

test("source ingest normalizes AI conversation JSONL and builds cited context", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-ai-test-"));
  const input = join(home, "codex.jsonl");
  writeFileSync(input, [
    JSON.stringify({ session_id: "sess-1", turn_id: "1", role: "user", content: "Review the pricing design", timestamp: "2026-07-16T01:00:00Z", files: ["design.md"] }),
    JSON.stringify({ session_id: "sess-1", turn_id: "2", role: "assistant", content: "The source must be retained.", timestamp: "2026-07-16T01:01:00Z", refs: ["run-1"] }),
  ].join("\n") + "\n");

  const result = importSource(home, input, { kind: "ai_conversation", scope: "work", title: "Codex pricing session" });
  assert.equal(result.source.kind, "ai_conversation");
  assert.equal(result.source.recordCount, 2);
  assert.match(result.source.recordsHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(readSourceRecords(home, result.source.id)[1].refs[0], "run-1");
  assert.equal(listSources(home)[0].id, result.source.id);
  const context = buildSourceContext(home, result.source.id);
  assert.match(context.markdown, /Review the pricing design/);
  assert.match(context.markdown, /design\.md/);
  assert.match(readFileSync(result.source.rawPath, "utf8"), /source must be retained/);
});

test("source ingest treats important documents and review comments as cited records", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-document-test-"));
  const documentPath = join(home, "design.md");
  const reviewPath = join(home, "review.md");
  writeFileSync(documentPath, "# Design\n\nPreserve the decision and its evidence.\n");
  writeFileSync(reviewPath, "# CR comment\n\nPlease add the failure evidence and explain why this path is safe.\n");
  const document = importSource(home, documentPath, { kind: "document", scope: "work" });
  const review = importSource(home, reviewPath, { kind: "review_comment", scope: "work" });
  const documentRecord = readSourceRecords(home, document.source.id)[0];
  const reviewRecord = readSourceRecords(home, review.source.id)[0];
  assert.equal(documentRecord.role, "document");
  assert.equal(reviewRecord.role, "review_comment");
  assert.deepEqual(documentRecord.refs, [documentPath]);
  assert.deepEqual(reviewRecord.refs, [reviewPath]);
  assert.equal(document.source.sensitivity, "work-internal");
  assert.equal(readFileSync(document.source.rawPath, "utf8"), readFileSync(documentPath, "utf8"));
  assert.equal(statSync(document.source.rawPath).mode & 0o777, 0o600);
  assert.equal(statSync(document.source.recordsPath).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(document.source.recordsPath)).mode & 0o777, 0o700);
  assert.match(buildSourceContext(home, document.source.id).markdown, /decision and its evidence/);
  assert.match(buildSourceContext(home, review.source.id).markdown, /failure evidence/);
});

test("source scope is validated before raw data is persisted", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-scope-test-"));
  const input = join(home, "document.md");
  writeFileSync(input, "# Scope validation\n");
  assert.throws(() => importSource(home, input, { kind: "document", scope: "typo" }), /personal or work/);
  assert.equal(listSources(home).length, 0);
});

test("direct Elephant ingest preserves nested sender, participants and content", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-elephant-test-"));
  const input = join(home, "elephant.ndjson");
  writeFileSync(input, `${JSON.stringify({
    conversation_id: "elephant-direct",
    id: "m1",
    role: "human",
    sender: { id: "person-a" },
    participants: [{ id: "person-a" }, { display_name: "person-b" }],
    sent_at: "2026-07-16T09:00:00+08:00",
    content: { text: "保留决定和依据。" },
  })}\n`);
  const result = importSource(home, input, { kind: "elephant", scope: "work" });
  const record = readSourceRecords(home, result.source.id)[0];
  assert.equal(record.actor, "person-a");
  assert.deepEqual(record.participants, ["person-a", "person-b"]);
  assert.equal(record.content, "保留决定和依据。");
  assert.equal(record.timestamp, "2026-07-16T09:00:00+08:00");
});

test("direct JSONL record ids remain unique across conversations with reused message ids", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-record-id-test-"));
  const input = join(home, "messages.jsonl");
  writeFileSync(input, [
    JSON.stringify({ conversation_id: "a", id: "1", content: "first" }),
    JSON.stringify({ conversation_id: "b", id: "1", content: "second" }),
  ].join("\n") + "\n");
  const result = importSource(home, input, { kind: "elephant", scope: "work" });
  const records = readSourceRecords(home, result.source.id);
  assert.equal(new Set(records.map((record) => record.id)).size, 2);
  assert.equal(records[0].id.includes(":a:1:1"), true);
  assert.equal(records[1].id.includes(":b:1:2"), true);
});

test("source integrity detects raw tampering and malformed or missing records", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-integrity-test-"));
  const input = join(home, "document.md");
  writeFileSync(input, "# Immutable evidence\n");
  const result = importSource(home, input, { kind: "document", scope: "work" });
  const originalRecord = readSourceRecords(home, result.source.id)[0];
  assert.deepEqual(inspectSourceIntegrity(home, result.source), []);

  writeFileSync(result.source.rawPath, "# Tampered evidence\n");
  assert.equal(inspectSourceIntegrity(home, result.source).some((issue) => issue.code === "raw_hash_mismatch"), true);

  const forgedRecord = { ...originalRecord, content: "Forged normalized evidence" };
  writeFileSync(result.source.recordsPath, `${JSON.stringify(forgedRecord)}\n`);
  const recordIssues = inspectSourceIntegrity(home, result.source);
  assert.equal(recordIssues.some((issue) => issue.code === "records_hash_mismatch"), true);
  assert.throws(() => readSourceRecords(home, result.source.id), /records_hash_mismatch/);
});

test("record projections can avoid rereading raw bytes while full reads stay strict", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-record-projection-test-"));
  const input = join(home, "document.md");
  writeFileSync(input, "# Projection\n");
  const result = importSource(home, input, { kind: "document", scope: "work" });
  writeFileSync(result.source.rawPath, "# Tampered raw\n");
  assert.doesNotThrow(() => readSourceRecords(home, result.source.id, { verifyRaw: false }));
  assert.throws(() => readSourceRecords(home, result.source.id), /raw_hash_mismatch/);
});

test("source registry reports torn directories and metadata id mismatches", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-registry-test-"));
  const orphanDirectory = join(home, "sources", "src-orphan");
  mkdirSync(join(orphanDirectory, "raw"), { recursive: true });
  writeFileSync(join(orphanDirectory, "raw", "input.md"), "orphan evidence\n");
  writeFileSync(join(orphanDirectory, "records.jsonl"), "{}\n");
  assert.equal(inspectSourceRegistry(home).issues[0].code, "source_metadata_missing");
  assert.throws(() => listSources(home), /source_metadata_missing/);

  writeFileSync(join(orphanDirectory, "source.json"), `${JSON.stringify({
    id: "src-different",
    title: "Mismatch",
    kind: "document",
    scope: "work",
    sensitivity: "work-internal",
    format: "markdown",
    originalPath: "/input.md",
    rawPath: join(orphanDirectory, "raw", "input.md"),
    recordsPath: join(orphanDirectory, "records.jsonl"),
    contentHash: "hash",
    recordCount: 1,
    importedAt: "2026-07-16T00:00:00Z",
  })}\n`);
  assert.equal(inspectSourceRegistry(home).issues[0].code, "source_id_directory_mismatch");
});

test("source import rejects escaping adapter ids before any source write", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-id-test-"));
  const input = join(home, "input.md");
  const escaped = join(home, "escaped-source");
  writeFileSync(input, "safe input\n");
  assert.throws(() => importSourceRecords(home, input, "safe input\n", { kind: "document", scope: "work" }, [], "../escaped-source"), /safe src-\* form/);
  assert.equal(existsSync(escaped), false);
});

test("source integrity rejects symlinked evidence paths", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-symlink-test-"));
  const input = join(home, "input.md");
  const external = join(home, "external.md");
  writeFileSync(input, "same evidence\n");
  writeFileSync(external, "same evidence\n");
  const result = importSource(home, input, { kind: "document", scope: "work" });
  unlinkSync(result.source.rawPath);
  symlinkSync(external, result.source.rawPath);
  assert.equal(inspectSourceIntegrity(home, result.source).some((issue) => issue.code === "path_is_symlink"), true);
  assert.throws(() => readSourceRecords(home, result.source.id), /path_is_symlink/);
});

test("source import and doctor reject a symlinked sources root", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-root-symlink-test-"));
  const externalRoot = mkdtempSync(join(tmpdir(), "ikb-external-sources-"));
  const input = join(home, "input.md");
  writeFileSync(input, "safe input\n");
  symlinkSync(externalRoot, join(home, "sources"), "dir");
  assert.throws(() => importSource(home, input, { kind: "document", scope: "work" }), /must not be a symlink/);
  assert.equal(inspectSourceRegistry(home).issues[0].code, "source_root_symlink");
});

test("quarantined historical project sources stay auditable but are excluded from the default source plane", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-quarantine-test-"));
  const input = join(home, "specx-session.jsonl");
  writeFileSync(input, `${JSON.stringify({ type: "user", sessionId: "s", uuid: "u", message: { role: "user", content: "historical" } })}\n`);
  const imported = importSource(home, input, { kind: "ai_conversation", adapter: "claude", scope: "work" });
  assert.equal(listSources(home).length, 0);
  assert.equal(listSources(home, { includeQuarantined: true }).length, 1);
  assert.equal(findSource(home, imported.source.id)?.id, imported.source.id);
  assert.equal(readSourceRecords(home, imported.source.id).length, 1);
});
