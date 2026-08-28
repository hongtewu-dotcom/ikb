import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { EventRecord, SourceRecord } from "../src/types.ts";
import { ingestHistory } from "../src/history.ts";
import { LedgerStore } from "../src/store.ts";
import { resolveLedgerPath, resolvePeopleRoot, resolveSourcesRoot, resolveVault } from "../src/layout.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(projectRoot, "src", "cli.ts");

test("CLI ingests and audits synthetic document, review, Claude, Codex, Desk and Elephant sources", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-source-cli-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  const inputs = join(sandbox, "inputs");
  mkdirSync(fakeUserHome, { recursive: true });
  mkdirSync(inputs, { recursive: true });
  runCli(home, fakeUserHome, ["init"]);

  const documentPath = join(inputs, "design.md");
  const reviewPath = join(inputs, "review.md");
  writeFileSync(documentPath, "# Synthetic design\n\nKeep the decision evidence.\n");
  writeFileSync(reviewPath, "# Synthetic review\n\nAdd a failure-path test.\n");
  const document = runCli(home, fakeUserHome, ["source", "ingest", documentPath, "--kind", "document", "--scope", "work"]);
  assert.equal(document.receipt.notice, "仅 Source，未准入为知识");
  runCli(home, fakeUserHome, ["source", "ingest", reviewPath, "--kind", "review_comment", "--scope", "work"]);
  const duplicateReview = runCli(home, fakeUserHome, ["source", "ingest", reviewPath, "--kind", "review_comment", "--scope", "work"]);
  assert.equal(duplicateReview.skipped, true);
  assert.equal(duplicateReview.reason, "unchanged");

  const historyInputs: Record<string, { filename: string; lines: unknown[] }> = {
    claude: {
      filename: "session.jsonl",
      lines: [
        { type: "user", sessionId: "claude-demo", uuid: "c1", timestamp: "2026-07-16T01:00:00Z", cwd: "/synthetic/repo", message: { role: "user", content: "Review the synthetic design" } },
        { type: "assistant", sessionId: "claude-demo", uuid: "c2", timestamp: "2026-07-16T01:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "Retain the cited evidence." }] } },
      ],
    },
    codex: {
      filename: "rollout.jsonl",
      lines: [
        { timestamp: "2026-07-16T02:00:00Z", type: "session_meta", payload: { session_id: "codex-demo", cwd: "/synthetic/repo" } },
        { timestamp: "2026-07-16T02:01:00Z", type: "event_msg", payload: { type: "user_message", message: "Check the failure path" } },
        { timestamp: "2026-07-16T02:02:00Z", type: "event_msg", payload: { type: "agent_message", message: "Add a deterministic test." } },
      ],
    },
    desk: {
      filename: "conversation.jsonl",
      lines: [
        { type: "user", conversationId: "desk-demo", timestamp: "2026-07-16T03:00:00Z", message: { content: [{ type: "text", text: "Draft the review note" }] } },
        { type: "assistant", conversationId: "desk-demo", timestamp: "2026-07-16T03:01:00Z", message: { content: [{ type: "text", text: "Record the decision." }] } },
      ],
    },
    elephant: {
      filename: "conversation.ndjson",
      lines: [
        { conversation_id: "elephant-demo", id: "e1", role: "human", sender: { id: "person-a" }, participants: [{ id: "person-a" }, { id: "person-b" }], sent_at: "2026-07-16T04:00:00+08:00", content: "把决定和依据记录下来。" },
        { conversation_id: "elephant-demo", id: "e2", role: "human", sender: { id: "person-b" }, sent_at: "2026-07-16T04:01:00+08:00", content: "后续按这个结论推进。" },
      ],
    },
  };

  for (const [adapter, fixture] of Object.entries(historyInputs)) {
    const root = join(inputs, adapter);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, fixture.filename), `${fixture.lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const scan = runCli(home, fakeUserHome, ["source", "ingest-history", "--adapter", adapter, "--root", root, "--scope", "work", "--limit", "0"]);
    assert.equal(scan.discovered, 1);
    assert.equal(scan.imported, 1);
    assert.equal(scan.failed, 0);
  }

  const sources = runCli(home, fakeUserHome, ["source", "list"]) as SourceRecord[];
  assert.equal(sources.length, 6);
  assert.deepEqual(new Set(sources.filter((source) => source.adapter).map((source) => source.adapter)), new Set(["claude", "codex", "desk", "elephant"]));
  assert.equal(sources.filter((source) => !source.adapter && source.kind === "document").length, 1);
  assert.equal(sources.filter((source) => !source.adapter && source.kind === "review_comment").length, 1);
  for (const source of sources) {
    assert.equal(source.scope, "work");
    assert.equal(source.sensitivity, "work-internal");
    assert.equal(source.recordCount > 0, true);
    assert.equal(existsSync(source.rawPath), true);
    assert.equal(existsSync(source.recordsPath), true);
  }

  const personView = runCli(home, fakeUserHome, ["source", "person", "--name", "person-a", "--context-window", "1"]);
  assert.equal(personView.sourceCount, 1);
  assert.equal(personView.matchedCount, 1);
  assert.equal(personView.matches[0].record.actor, "person-a");
  assert.equal(personView.matches[0].context.length, 2);

  const context = runCli(home, fakeUserHome, ["source", "context", document.source.id]);
  assert.match(context.markdown, /decision evidence/);
  const aliases = runCli(home, fakeUserHome, ["source", "alias-add", document.source.id, "--alias", "Synthetic 接入文档,决策证据"]);
  assert.deepEqual(aliases.added, ["Synthetic 接入文档", "决策证据"]);
  const byTitle = runCli(home, fakeUserHome, ["source", "lookup", "design", "--scope", "work"]);
  assert.equal(byTitle[0].source.id, document.source.id);
  const byAlias = runCli(home, fakeUserHome, ["source", "lookup", "决策证据", "--scope", "work"]);
  assert.equal(byAlias[0].source.id, document.source.id);
  const receipt = runCli(home, fakeUserHome, ["source", "receipt", document.source.id]);
  assert.equal(receipt.notice, "仅 Source，未准入为知识");
  const events = readFileSync(resolveLedgerPath(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as EventRecord);
  assert.equal(events.filter((event) => event.eventType === "source.ingested").length, 6);
  assert.equal(events.filter((event) => event.eventType === "source.aliases_updated").length, 1);
  assert.equal(events.filter((event) => event.eventType === "source.history_scan").length, 4);
  const doctor = runCli(home, fakeUserHome, ["doctor"]);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.sources, 6);
});

test("CLI captures by collection and records an explicit legacy migration", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-knowledge-cli-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  mkdirSync(fakeUserHome, { recursive: true });
  runCli(home, fakeUserHome, ["init"]);

  const captured = runCli(home, fakeUserHome, [
    "capture", "Person A expects failure evidence.",
    "--title", "Person A review expectation",
    "--type", "preference",
    "--collection", "people",
    "--scope", "work",
    "--source", "src-demo:m1",
  ]);
  assert.equal(captured.path.startsWith(join(resolveVault(home, "work"), "people")), true);
  assert.equal(captured.collection, "people");

  const legacyDirectory = join(resolveVault(home, "work"), "entries");
  const legacyPath = join(legacyDirectory, "2026-07-16-kb-cli-legacy.md");
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(legacyPath, [
    "---",
    "id: kb-cli-legacy",
    "type: decision",
    "scope: work",
    "status: draft",
    "title: \"Legacy CLI decision\"",
    "source_refs: [\"src-demo:m2\"]",
    "valid_from: 2026-07-16",
    "review_after: 2026-10-16",
    "tags: []",
    "aliases: [\"kb-cli-legacy\"]",
    "related: []",
    "derived_from: []",
    "contradicts: []",
    "---",
    "Use explicit migration.",
    "",
  ].join("\n"));
  runCli(home, fakeUserHome, ["knowledge", "rebuild", "--scope", "work"]);
  const migration = runCli(home, fakeUserHome, ["knowledge", "migrate", "--scope", "work"]);
  assert.equal(migration.moved.length, 1);
  assert.equal(migration.moved[0].collection, "decisions");
  assert.equal(existsSync(legacyPath), false);
  assert.equal(existsSync(join(resolveVault(home, "work"), "decisions", "2026-07-16-kb-cli-legacy.md")), true);

  const events = readFileSync(resolveLedgerPath(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as EventRecord);
  assert.equal(events.filter((event) => event.eventType === "knowledge.created").length, 1);
  assert.equal(events.filter((event) => event.eventType === "knowledge.migrated").length, 1);
  assert.equal(events.find((event) => event.eventType === "knowledge.created")?.payload.collection, "people");
  assert.equal(runCli(home, fakeUserHome, ["doctor"]).ok, true);
});

test("CLI resolve-all reads every discovered Citadel candidate and isolates access failures", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-citadel-resolve-all-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  const input = join(sandbox, "agent.jsonl");
  const fakeCitadel = join(sandbox, "fake-citadel");
  mkdirSync(fakeUserHome, { recursive: true });
  writeFileSync(fakeCitadel, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "const id = args[args.indexOf('--contentId') + 1];",
    "if (id === '456') { console.error('permission denied'); process.exit(1); }",
    "const op = args[1];",
    "if (op === 'getSimpleMarkdown') console.log(JSON.stringify({ title: `Synthetic ${id}`, content: `# Synthetic ${id}\\n\\nDurable evidence.` }));",
    "else if (op === 'getDocumentMetaInfo') console.log(JSON.stringify({ title: `Synthetic ${id}` }));",
    "else if (op === 'getAllComments') console.log(JSON.stringify({ comments: [] }));",
    "else { console.error(`unexpected operation: ${op}`); process.exit(1); }",
    "",
  ].join("\n"));
  chmodSync(fakeCitadel, 0o755);
  writeFileSync(input, `${JSON.stringify({ id: "m1", conversation_id: "c1", role: "user", content: "Read https://km.sankuai.com/page/123 and contentId:456" })}\n`);
  runCli(home, fakeUserHome, ["init"]);
  const source = runCli(home, fakeUserHome, ["source", "ingest", input, "--kind", "ai_conversation", "--adapter", "codex", "--scope", "work"]);
  runCli(home, fakeUserHome, ["candidate", "discover-all", "--scope", "work"]);
  const resolved = runCli(home, fakeUserHome, ["candidate", "resolve-all", "--scope", "work", "--delay-ms", "0"], { IKB_CITADEL_COMMAND: fakeCitadel });
  assert.equal(resolved.discovered, 2);
  assert.equal(resolved.ingested, 1);
  assert.equal(resolved.blocked, 1);
  const candidates = runCli(home, fakeUserHome, ["candidate", "list", "--scope", "work"]);
  assert.equal(candidates.find((candidate: { locator: { contentId?: string } }) => candidate.locator.contentId === "123")?.status, "ingested");
  assert.equal(candidates.find((candidate: { locator: { contentId?: string } }) => candidate.locator.contentId === "456")?.status, "blocked");
  const sources = runCli(home, fakeUserHome, ["source", "list", "--scope", "work"]);
  assert.equal(sources.some((item: { adapter?: string; kind: string }) => item.adapter === "citadel" && item.kind === "document"), true);
  assert.equal(runCli(home, fakeUserHome, ["doctor"]).ok, true);
  const events = readFileSync(resolveLedgerPath(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as EventRecord);
  assert.equal(events.filter((event) => event.eventType === "candidate.queued").length, 2);
  assert.equal(events.filter((event) => event.eventType === "candidate.ingested").length, 1);
  assert.equal(events.filter((event) => event.eventType === "candidate.blocked").length, 1);
  assert.equal(source.source.kind, "ai_conversation");
});

test("CLI resolve-all enforces ten Citadel reads per rolling thirty-minute window", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-citadel-rate-limit-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  mkdirSync(fakeUserHome, { recursive: true });
  runCli(home, fakeUserHome, ["init"]);
  const added = runCli(home, fakeUserHome, [
    "candidate", "add", "--kind", "citadel_document", "--title", "Rate limited candidate",
    "--adapter", "citadel", "--content-id", "999", "--scope", "work",
  ]);
  const ledger = new LedgerStore({ home });
  try {
    for (let index = 0; index < 10; index += 1) {
      ledger.recordCandidateEvent(added.candidate.id, "candidate.resolve_started", {
        adapter: "citadel", contentId: "prior", scope: "work", reason: "test fixture",
      });
    }
  } finally {
    ledger.close();
  }
  const limited = runCli(home, fakeUserHome, ["candidate", "resolve-all", "--scope", "work", "--limit", "0", "--delay-ms", "0"], {
    IKB_CITADEL_COMMAND: join(sandbox, "must-not-be-called"),
  });
  assert.equal(limited.discovered, 0);
  assert.equal(limited.remaining, 1);
  assert.equal(limited.skippedByRateLimit, 1);
  assert.equal(limited.rateLimit.max, 10);
  assert.equal(limited.rateLimit.windowMinutes, 30);
  assert.equal(limited.rateLimit.used, 10);
  assert.equal(limited.rateLimit.remaining, 0);
  assert.equal(runCli(home, fakeUserHome, ["doctor"]).ok, true);
});

test("CLI context pack carries draft use guidance and records knowledge references", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-context-cli-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  mkdirSync(fakeUserHome, { recursive: true });
  runCli(home, fakeUserHome, ["init"]);
  runCli(home, fakeUserHome, ["capture", "Use code paths and real responses together.", "--title", "Interface automation use card", "--scope", "work", "--source", "src-demo:interface"]);
  const personalOnly = runCli(home, fakeUserHome, ["capture", "Use the interface automation card for a private personal workflow.", "--title", "Review interface automation personal override", "--scope", "personal", "--source", "manual:personal"]);
  const verified = runCli(home, fakeUserHome, ["capture", "Keep the interface entry evidence.", "--title", "Verified interface rule", "--scope", "work", "--status", "verified", "--source", "src-demo:verified"]);
  const task = runCli(home, fakeUserHome, ["task", "add", "--title", "Review interface automation", "--goal", "Use the interface automation card", "--accept", "Produce a path diff", "--type", "review", "--scope", "work"]);
  runCli(home, fakeUserHome, ["task", "start", task.id]);
  const run = runCli(home, fakeUserHome, ["run", "start", task.id, "--agent", "ikb-operator", "--skill", "review"]);
  const context = runCli(home, fakeUserHome, ["context", task.id, "--run", run.id]);
  assert.equal(context.results.some((item: { title: string; status: string }) => item.title === "Interface automation use card" && item.status === "draft"), true);
  assert.equal(context.results.some((item: { id: string }) => item.id === personalOnly.id), false);
  assert.match(context.markdown, /verified \+ draft/);
  assert.equal(context.units.length > 0, true);
  assert.equal(context.units.every((unit: { unitId?: string; kind?: string; text?: string }) => typeof unit.unitId === "string" && typeof unit.kind === "string" && !("text" in unit)), true);
  assert.equal(context.results.every((item: { body?: string }) => !("body" in item)), true);
  assert.match(context.contextArtifact.id, /^artifact-/);
  assert.match(context.contextArtifact.path, /context-pack-[a-f0-9]{16}\.md$/);
  assert.equal(existsSync(context.contextArtifact.path), true);
  assert.equal(existsSync(join(run.runDir, "context-pack.md")), true);
  const repeated = runCli(home, fakeUserHome, ["context", task.id, "--run", run.id]);
  assert.equal(repeated.contextArtifact.id, context.contextArtifact.id);
  const scopeMismatch = invokeCli(home, fakeUserHome, ["context", task.id, "--run", run.id, "--scope", "personal"]);
  assert.notEqual(scopeMismatch.status, 0);
  assert.match(scopeMismatch.stderr, /does not match Task scope work/);
  const events = readFileSync(resolveLedgerPath(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as EventRecord);
  const referenced = events.filter((event) => event.eventType === "knowledge.referenced");
  assert.equal(referenced.some((event) => event.aggregateId === verified.id), true);
  assert.equal(referenced.every((event) => event.payload.runId === run.id), true);
  assert.equal(events.filter((event) => event.eventType === "artifact.created" && event.payload.kind === "context-pack").length, 1);
  assert.equal(events.filter((event) => event.aggregateId === run.id && event.eventType === "run.artifact_linked" && event.payload.artifactId === context.contextArtifact.id && event.payload.relation === "produced").length, 1);
  assert.equal(new Set(referenced.map((event) => `${event.aggregateId}:${event.payload.contextHash}`)).size, referenced.length);
  assert.equal(runCli(home, fakeUserHome, ["doctor"]).ok, true);
});

test("CLI context omits a routed parent when it has no directly answerable unit", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-context-cli-zero-unit-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  mkdirSync(fakeUserHome, { recursive: true });
  runCli(home, fakeUserHome, ["init"]);
  runCli(home, fakeUserHome, ["capture", "# 旁路说明\n\n召回。", "--title", "IKB专属召回契约", "--scope", "work", "--source", "src-demo:zero-unit"]);
  const task = runCli(home, fakeUserHome, ["task", "add", "--title", "IKB专属召回契约", "--goal", "只返回直接回答的问题级单元", "--accept", "没有合格单元时返回零结果", "--type", "coding", "--scope", "work"]);
  runCli(home, fakeUserHome, ["task", "start", task.id]);
  const run = runCli(home, fakeUserHome, ["run", "start", task.id, "--agent", "ikb-operator", "--skill", "coding"]);

  const context = runCli(home, fakeUserHome, ["context", task.id, "--run", run.id]);

  assert.match(context.markdown, /Context Pack/);
  assert.deepEqual(context.results, []);
  assert.deepEqual(context.units, []);
  assert.doesNotMatch(context.markdown, /## IKB专属召回契约/);
});

test("CLI context suppresses only explicitly unrelated Knowledge from the retry ancestor chain", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-context-retry-feedback-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  mkdirSync(fakeUserHome, { recursive: true });
  runCli(home, fakeUserHome, ["init"]);
  const suppressed = runCli(home, fakeUserHome, ["capture", "Pi/Magent retry ancestor card directly answers the retry question.", "--title", "Pi/Magent retry ancestor card", "--scope", "work", "--source", "src-demo:retry-suppressed"]);
  const ordinary = runCli(home, fakeUserHome, ["capture", "Pi/Magent ordinary unused card directly answers the retry question.", "--title", "Pi/Magent ordinary unused card", "--scope", "work", "--source", "src-demo:retry-ordinary"]);
  const task = runCli(home, fakeUserHome, ["task", "add", "--title", "Pi/Magent retry ancestor card ordinary unused card", "--goal", "answer the Pi/Magent retry question", "--accept", "only relevant retry Knowledge remains", "--type", "coding", "--scope", "work"]);
  const store = new LedgerStore({ home });
  const ancestor = store.createRun(task.id, "ikb-operator", ["coding"]);
  store.recordKnowledgeEvent(suppressed.id, "knowledge.feedback_recorded", {
    contractVersion: "knowledge-usage.v1",
    taskId: task.id,
    runId: ancestor.id,
    outcome: "unused",
    reasonCode: "unrelated-domain",
    note: "Previous retry lineage proved this card belongs to another domain.",
  });
  store.recordKnowledgeEvent(ordinary.id, "knowledge.feedback_recorded", {
    contractVersion: "knowledge-usage.v1",
    taskId: task.id,
    runId: ancestor.id,
    outcome: "unused",
    reasonCode: "not_relevant",
    note: "Ordinary unused feedback must not globally suppress this card.",
  });
  const retry = store.createRun(task.id, "ikb-operator", ["coding"], ancestor.id);
  const independent = store.createRun(task.id, "ikb-operator", ["coding"]);
  store.close();

  const retryContext = runCli(home, fakeUserHome, ["context", task.id, "--run", retry.id]);
  assert.equal(retryContext.results.some((item: { id: string }) => item.id === suppressed.id), false);
  assert.equal(retryContext.results.some((item: { id: string }) => item.id === ordinary.id), true);
  assert.deepEqual((retryContext.retrieval as { priorFeedbackExcludedIds?: string[] }).priorFeedbackExcludedIds, [suppressed.id]);

  const independentContext = runCli(home, fakeUserHome, ["context", task.id, "--run", independent.id]);
  assert.deepEqual((independentContext.retrieval as { priorFeedbackExcludedIds?: string[] }).priorFeedbackExcludedIds, []);
});

test("CLI records a no-knowledge decision once without creating a Vault note", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-knowledge-skip-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  const input = join(sandbox, "thin-document.md");
  mkdirSync(fakeUserHome, { recursive: true });
  writeFileSync(input, "# Routine status\n\nNo durable decision or reusable method.\n");
  runCli(home, fakeUserHome, ["init"]);
  const ingested = runCli(home, fakeUserHome, ["source", "ingest", input, "--kind", "document", "--scope", "work"]);

  const first = runCli(home, fakeUserHome, [
    "knowledge", "skip",
    "--title", "Routine status has no durable knowledge",
    "--reason", "The source only reports a transient status and contains no reusable claim.",
    "--source-id", ingested.source.id,
  ]);
  const second = runCli(home, fakeUserHome, [
    "knowledge", "skip",
    "--title", "Routine status has no durable knowledge",
    "--reason", "The source only reports a transient status and contains no reusable claim.",
    "--source-id", ingested.source.id,
  ]);

  assert.equal(first.decision, "skip");
  assert.equal(first.knowledge, null);
  assert.equal(first.created, true);
  assert.equal(first.candidate.kind, "knowledge");
  assert.equal(first.candidate.status, "rejected");
  assert.equal(first.candidate.scope, "work");
  assert.equal(second.candidate.id, first.candidate.id);
  assert.equal(second.created, false);
  assert.equal(second.changed, false);
  const scopeMismatch = invokeCli(home, fakeUserHome, [
    "knowledge", "skip",
    "--title", "Routine status has no durable knowledge",
    "--reason", "The source only reports a transient status and contains no reusable claim.",
    "--source-id", ingested.source.id,
    "--scope", "personal",
  ]);
  assert.equal(scopeMismatch.status, 1);
  assert.match(scopeMismatch.stderr, /does not match evidence scope work/);
  assert.deepEqual(runCli(home, fakeUserHome, ["knowledge", "list", "--scope", "work"]), []);
  const events = readFileSync(resolveLedgerPath(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as EventRecord);
  assert.equal(events.filter((event) => event.aggregateId === first.candidate.id && event.eventType === "candidate.rejected").length, 1);
  assert.equal(runCli(home, fakeUserHome, ["doctor"]).ok, true);
});

test("knowledge lint exits non-zero when an edited note violates the quality gate", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-knowledge-lint-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  mkdirSync(fakeUserHome, { recursive: true });
  runCli(home, fakeUserHome, ["init"]);
  const captured = runCli(home, fakeUserHome, ["capture", "Readable body.", "--title", "Editable note"]);
  assert.equal(runCli(home, fakeUserHome, ["knowledge", "lint", captured.id]).ok, true);

  writeFileSync(captured.path, readFileSync(captured.path, "utf8").replace("Readable body.", "Broken\\nbody."));
  const lint = invokeCli(home, fakeUserHome, ["knowledge", "lint", captured.id]);
  assert.equal(lint.status, 2);
  const lintResult = JSON.parse(lint.stdout);
  assert.equal(lintResult.ok, false);
  assert.equal(lintResult.results[0].issues[0].code, "literal_escaped_newline");
  const doctor = invokeCli(home, fakeUserHome, ["doctor"]);
  assert.equal(doctor.status, 2);
  assert.equal(JSON.parse(doctor.stdout).knowledgeLayout.qualityIssues[0].knowledgeId, captured.id);
});

test("CLI maintains the private key people list and records changes", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-key-people-cli-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  mkdirSync(fakeUserHome, { recursive: true });
  runCli(home, fakeUserHome, ["init"]);

  const added = runCli(home, fakeUserHome, ["people", "add", "alice", "--mis", "alice", "--scope", "work"]);
  assert.equal(added.id, "alice");
  const listed = runCli(home, fakeUserHome, ["people", "list", "--scope", "work"]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].mis, "alice");
  const updated = runCli(home, fakeUserHome, ["people", "update", "alice", "--name", "示例用户", "--uid", "uid-alice", "--aliases", "示例用户,A"]);
  assert.equal(updated.name, "示例用户");
  assert.equal(updated.uid, "uid-alice");
  const removed = runCli(home, fakeUserHome, ["people", "remove", "alice"]);
  assert.equal(removed.id, "alice");
  assert.deepEqual(runCli(home, fakeUserHome, ["people", "list"]), []);
  const events = readFileSync(resolveLedgerPath(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as EventRecord);
  assert.deepEqual(events.filter((event) => event.aggregateType === "person").map((event) => event.eventType), ["person.added", "person.updated", "person.removed"]);
});

test("CLI rebuilds a cross-source person dossier and records the projection", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-dossier-cli-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  const input = join(sandbox, "messages.jsonl");
  mkdirSync(fakeUserHome, { recursive: true });
  writeFileSync(input, `${JSON.stringify({ id: "m1", conversation_id: "g1", actor: "alice", content: "Keep the evidence.", timestamp: "2026-07-16T01:00:00Z", refs: ["senderMis:alice"] })}\n`);
  runCli(home, fakeUserHome, ["init"]);
  runCli(home, fakeUserHome, ["source", "ingest", input, "--kind", "elephant", "--scope", "work"]);
  runCli(home, fakeUserHome, ["people", "add", "alice", "--mis", "alice", "--scope", "work"]);

  const dossier = runCli(home, fakeUserHome, ["people", "view", "alice", "--scope", "work", "--limit", "10"]);
  assert.equal(dossier.matchedCount, 1);
  assert.equal(dossier.entries[0].content, "Keep the evidence.");
  assert.equal(existsSync(dossier.path), true);
  assert.match(readFileSync(dossier.path, "utf8"), /Keep the evidence/);
  assert.match(readFileSync(join(resolvePeopleRoot(home, "work"), "index.md"), "utf8"), /alice\/index/);

  const rebuilt = runCli(home, fakeUserHome, ["people", "rebuild", "--scope", "work", "--limit", "10"]);
  assert.equal(rebuilt.length, 1);
  const events = readFileSync(resolveLedgerPath(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as EventRecord);
  assert.equal(events.filter((event) => event.eventType === "person.view_built").length, 2);
  assert.equal(runCli(home, fakeUserHome, ["doctor"]).ok, true);
});

test("CLI doctor rejects a tampered raw source snapshot", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-source-doctor-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  const input = join(sandbox, "evidence.md");
  mkdirSync(fakeUserHome, { recursive: true });
  writeFileSync(input, "# Original evidence\n");
  runCli(home, fakeUserHome, ["init"]);
  const imported = runCli(home, fakeUserHome, ["source", "ingest", input, "--kind", "document", "--scope", "work"]);
  writeFileSync(imported.source.rawPath, "# Tampered evidence\n");

  const result = invokeCli(home, fakeUserHome, ["doctor"]);
  assert.equal(result.status, 2);
  const doctor = JSON.parse(result.stdout);
  assert.equal(doctor.ok, false);
  assert.equal(doctor.sourceIssues.some((issue: { code: string }) => issue.code === "raw_hash_mismatch"), true);
});

test("CLI doctor rejects an orphan source directory", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-source-orphan-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  mkdirSync(fakeUserHome, { recursive: true });
  runCli(home, fakeUserHome, ["init"]);
  const orphan = join(resolveSourcesRoot(home), "src-orphan");
  mkdirSync(join(orphan, "raw"), { recursive: true });
  writeFileSync(join(orphan, "raw", "input.md"), "orphan evidence\n");
  writeFileSync(join(orphan, "records.jsonl"), "{}\n");

  const result = invokeCli(home, fakeUserHome, ["doctor"]);
  assert.equal(result.status, 2);
  const doctor = JSON.parse(result.stdout);
  assert.equal(doctor.ok, false);
  assert.equal(doctor.sourceIssues.some((issue: { code: string }) => issue.code === "source_metadata_missing"), true);
});

test("CLI doctor rejects Source metadata drift from the ledger", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-source-ledger-drift-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  const input = join(sandbox, "evidence.md");
  mkdirSync(fakeUserHome, { recursive: true });
  writeFileSync(input, "# Evidence\n");
  runCli(home, fakeUserHome, ["init"]);
  const imported = runCli(home, fakeUserHome, ["source", "ingest", input, "--kind", "document", "--scope", "work"]);
  const metadataPath = join(resolveSourcesRoot(home), imported.source.id, "source.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  metadata.scope = "personal";
  metadata.sensitivity = "public";
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  const result = invokeCli(home, fakeUserHome, ["doctor"]);
  assert.equal(result.status, 2);
  const doctor = JSON.parse(result.stdout);
  assert.equal(doctor.sourceIssues.some((issue: { code: string }) => issue.code === "source_metadata_ledger_mismatch"), true);
});

test("history retry reconciles a Source written before its ledger event", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-source-reconcile-e2e-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  const root = join(sandbox, "history");
  mkdirSync(fakeUserHome, { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "session.jsonl"), `${JSON.stringify({ type: "user", sessionId: "recover", uuid: "u1", message: { content: "Recover the ledger event." } })}\n`);
  runCli(home, fakeUserHome, ["init"]);
  const interrupted = ingestHistory(home, "claude", { root, scope: "work" });
  assert.equal(interrupted.imported, 1);
  assert.equal(readFileSync(resolveLedgerPath(home), "utf8"), "");

  const retried = runCli(home, fakeUserHome, ["source", "ingest-history", "--adapter", "claude", "--root", root, "--scope", "work"]);
  assert.equal(retried.skipped, 1);
  const events = readFileSync(resolveLedgerPath(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as EventRecord);
  assert.equal(events.filter((event) => event.eventType === "source.ingested").length, 1);
  assert.equal(runCli(home, fakeUserHome, ["doctor"]).ok, true);
});

test("CLI incremental ingest appends only a delta and records the scan state", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-source-incremental-cli-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  const input = join(sandbox, "messages.jsonl");
  mkdirSync(fakeUserHome, { recursive: true });
  runCli(home, fakeUserHome, ["init"]);
  const write = (rows: unknown[]) => writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  write([{ conversation_id: "incremental", id: "m1", role: "user", content: "first" }]);
  const first = runCli(home, fakeUserHome, ["source", "ingest", input, "--kind", "ai_conversation", "--adapter", "synthetic", "--scope", "work", "--incremental"]);
  assert.equal(first.deltaCount, 1);
  write([
    { conversation_id: "incremental", id: "m1", role: "user", content: "first" },
    { conversation_id: "incremental", id: "m2", role: "assistant", content: "second" },
  ]);
  const second = runCli(home, fakeUserHome, ["source", "ingest", input, "--kind", "ai_conversation", "--adapter", "synthetic", "--scope", "work", "--incremental"]);
  assert.equal(second.deltaCount, 1);
  assert.equal(second.duplicateCount, 1);
  assert.equal(second.source.recordCount, 1);
  const events = readFileSync(resolveLedgerPath(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as EventRecord);
  assert.equal(events.filter((event) => event.eventType === "source.incremental_scan").length, 2);
  assert.equal(runCli(home, fakeUserHome, ["doctor"]).ok, true);
});

test("CLI search and context reject unbounded or malformed result limits", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-bounded-retrieval-cli-"));
  const home = join(sandbox, "ikb-data");
  const fakeUserHome = join(sandbox, "fake-home");
  mkdirSync(fakeUserHome, { recursive: true });
  runCli(home, fakeUserHome, ["init"]);
  for (const suffix of ["one", "two", "three"]) {
    runCli(home, fakeUserHome, ["capture", `bounded retrieval ${suffix}`, "--title", `Bounded ${suffix}`, "--scope", "personal"]);
  }

  const limited = runCli(home, fakeUserHome, ["search", "bounded retrieval", "--scope", "personal", "--limit", "2"]);
  assert.equal(limited.length, 2);
  for (const invalid of ["0", "1.5", "51", "not-a-number"]) {
    const result = invokeCli(home, fakeUserHome, ["search", "bounded retrieval", "--scope", "personal", "--limit", invalid]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--limit must be an integer from 1 to 50/);
  }

  const task = runCli(home, fakeUserHome, ["task", "add", "--title", "Context limit", "--goal", "Bound context", "--accept", "Bounded", "--scope", "personal"]);
  const run = runCli(home, fakeUserHome, ["run", "start", task.id, "--agent", "ikb-operator"]);
  const invalidContext = invokeCli(home, fakeUserHome, ["context", task.id, "--run", run.id, "--scope", "personal", "--limit", "0"]);
  assert.notEqual(invalidContext.status, 0);
  assert.match(invalidContext.stderr, /--limit must be an integer from 1 to 50/);
});

function runCli(home: string, fakeUserHome: string, args: string[], envOverrides: Record<string, string> = {}): any {
  const result = invokeCli(home, fakeUserHome, args, envOverrides);
  if (result.status !== 0) throw new Error(`ikb ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function invokeCli(home: string, fakeUserHome: string, args: string[], envOverrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--experimental-strip-types", cliPath, ...args, "--home", home, "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: fakeUserHome, ...envOverrides },
  });
}
