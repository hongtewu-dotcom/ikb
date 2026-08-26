export const meta = {
  name: "agent_teams_feature",
  description:
    "Plan → frozen contracts → parallel disjoint writers with optional risk-based checkpoints → read-only reviewers → single integration. Writer Barrier stays closed until contracts are frozen.",
  phases: [
    { title: "Plan" },
    { title: "Freeze contracts" },
    { title: "Write" },
    { title: "Review" },
    { title: "Integrate" },
  ],
};

// ADAPT: supply the feature brief, repo root, and writer decomposition from context.
const brief = args && typeof args.brief === "string" ? args.brief : "";
if (!brief) throw new Error("args.brief must be supplied by context");
const maxConcurrency = args && typeof args.concurrency === "number" ? Math.min(4, Math.max(1, args.concurrency)) : 4;
const repoRoot = args && typeof args.repoRoot === "string" ? args.repoRoot : process.cwd();

const runInWaves = async (tasks) => {
  const outcomes = [];
  for (let offset = 0; offset < tasks.length; offset += maxConcurrency) {
    outcomes.push(...(await parallel(tasks.slice(offset, offset + maxConcurrency))));
  }
  return outcomes;
};

const receiptSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "partial", "blocked"] },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    changes: { type: "array", items: { type: "string" } },
    validation: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "evidence", "changes", "validation", "gaps"],
  additionalProperties: false,
};

phase("Plan");
const plan = await agent(
  [
    `Plan the feature below into bounded disjoint write streams; execution runs at most ${maxConcurrency} writers concurrently.`,
    `Repo root: ${repoRoot}`,
    brief,
    "Output writer decomposition (module, owned files), shared contracts that must be frozen first, and an integration/consumer step.",
    "Every writer must carry goal/scope/acceptance/handoff plus writer fields.",
    "Each shared_contract is identified by its index (0-based) in shared_contracts. Fill consumes with the contract indices this writer consumes, and produces_contracts with the indices it produces (e.g. the src writer produces the function-signature contract, the tests writer consumes it). Every contract index must be owned by at least one writer.",
  ].join("\n"),
  {
    label: "plan-feature",
    schema: {
      type: "object",
      properties: {
        writers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              goal: { type: "string" },
              scope: { type: "string" },
              acceptance: {
                type: "array",
                items: { type: "string" },
                minItems: 1,
              },
              write_scope: { type: "array", items: { type: "string" } },
              forbidden_scope: { type: "array", items: { type: "string" } },
              depends_on: { type: "array", items: { type: "string" } },
              produces: { type: "array", items: { type: "string" } },
              consumes: { type: "array", items: { type: "integer", minimum: 0 } },
              produces_contracts: { type: "array", items: { type: "integer", minimum: 0 } },
              first_checkpoint: { type: "string" },
            },
            required: [
              "id",
              "goal",
              "scope",
              "acceptance",
              "write_scope",
              "forbidden_scope",
              "depends_on",
              "produces",
              "consumes",
              "produces_contracts",
            ],
            additionalProperties: false,
          },
        },
        shared_contracts: { type: "array", items: { type: "string" } },
        integration: { type: "string" },
      },
      required: ["writers", "shared_contracts", "integration"],
      additionalProperties: false,
    },
  },
);
const planMissing = plan === null;
const writers = planMissing ? [] : plan.writers;

phase("Freeze contracts");
// INVARIANT (F1/GOV-2): the Writer Barrier opens only when (a) shared contracts are
// frozen and accepted by every writer, and (b) write scopes are disjoint with each
// writer's forbidden_scope covering all other writers' write_scope.
let barrierOpen = false;
let sharedContracts = [];
if (!planMissing) {
  sharedContracts = Array.isArray(plan.shared_contracts) ? plan.shared_contracts : [];
  const disjoint = writers.every((writer, i) =>
    writers.every((other, j) =>
      i === j ||
      writer.write_scope.every((p) => !other.write_scope.some((q) => p === q || p.startsWith(q) || q.startsWith(p))),
    ),
  );
  const forbiddenCoversPeers = writers.every((writer, i) =>
    writers.every((other, j) =>
      i === j || other.write_scope.every((p) => writer.forbidden_scope.some((f) => f === p || p.startsWith(f))),
    ),
  );
  // INVARIANT (F1/GOV-2): every declared shared contract must be owned by at
  // least one writer — as a consumer (depends_on)
  // or a producer (produces). A contract that nobody consumes or produces is an
  // orphan and cannot be considered frozen. An empty list is valid when the
  // disjoint streams share no contract. Producers need not depend on their own
  // contract; only consumers do.
  const contractOwned = (index) =>
    writers.some(
      (writer) =>
        (writer.consumes || []).includes(index) || (writer.produces_contracts || []).includes(index),
    );
  const sharedContractsFrozen = sharedContracts.every((contract, index) => contractOwned(index));
  barrierOpen = disjoint && forbiddenCoversPeers && sharedContractsFrozen && writers.length > 0;
  if (!barrierOpen) {
    const frozen = await agent(
      [
        `The writer decomposition below is not barrier-safe (overlapping write_scope, or forbidden_scope does not cover peers, or acceptance/handoff missing).`,
        "Redistribute ownership so every file has one owner, each forbidden_scope covers all peer write scopes, and every writer has acceptance + handoff.",
        "Keep the shared contract list explicit; return the corrected writer list and shared contracts.",
        JSON.stringify(writers),
      ].join("\n"),
      {
        label: "freeze-contracts",
        schema: {
          type: "object",
          properties: {
            writers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  goal: { type: "string" },
                  scope: { type: "string" },
                  acceptance: {
                    type: "array",
                    items: { type: "string" },
                    minItems: 1,
                  },
                  write_scope: { type: "array", items: { type: "string" } },
                  forbidden_scope: { type: "array", items: { type: "string" } },
                  depends_on: { type: "array", items: { type: "string" } },
                  produces: { type: "array", items: { type: "string" } },
                  consumes: { type: "array", items: { type: "integer", minimum: 0 } },
                  produces_contracts: { type: "array", items: { type: "integer", minimum: 0 } },
                  first_checkpoint: { type: "string" },
                },
                required: [
                  "id",
                  "goal",
                  "scope",
                  "acceptance",
                  "write_scope",
                  "forbidden_scope",
                  "depends_on",
                  "produces",
                  "consumes",
                  "produces_contracts",
                ],
                additionalProperties: false,
              },
            },
            shared_contracts: { type: "array", items: { type: "string" } },
          },
          required: ["writers", "shared_contracts"],
          additionalProperties: false,
        },
      },
    );
    const frozenMissing = frozen === null;
    if (!frozenMissing) {
      writers.splice(0, writers.length, ...frozen.writers);
      sharedContracts = Array.isArray(frozen.shared_contracts) ? frozen.shared_contracts : sharedContracts;
      const stillDisjoint = writers.every((writer, i) =>
        writers.every((other, j) =>
          i === j ||
          writer.write_scope.every((p) => !other.write_scope.some((q) => p === q || p.startsWith(q) || q.startsWith(p))),
        ),
      );
      const stillCovers = writers.every((writer, i) =>
        writers.every((other, j) =>
          i === j || other.write_scope.every((p) => writer.forbidden_scope.some((f) => f === p || p.startsWith(f))),
        ),
      );
      const contractOwned2 = (index) =>
        writers.some(
          (writer) =>
            (writer.consumes || []).includes(index) || (writer.produces_contracts || []).includes(index),
        );
      const stillFrozen = sharedContracts.every((contract, index) => contractOwned2(index));
      barrierOpen = stillDisjoint && stillCovers && stillFrozen && writers.length > 0;
    }
  }
}

phase("Write");
// INVARIANT (feature smoke 2026-08-10): writers with contract dependencies must
// NOT run in parallel with their producers. Layer by dependency:
//   wave 1: producers (writers whose consumes is empty) run first and complete;
//   wave 2: consumers run only after every contract index they consume has been
//           produced by a completed writer.
// first_checkpoint is optional and used only when risk or ownership ambiguity
// makes intermediate inspection materially safer.
const buildWriterPrompt = (writer) =>
  [
    `goal: ${writer.goal}`,
    `scope: ${writer.scope}`,
    `acceptance: ${(writer.acceptance || []).join("; ")}`,
    `write_scope: ${writer.write_scope.join(", ")}`,
    `forbidden_scope: ${writer.forbidden_scope.join(", ")}`,
    `depends_on (frozen contracts): ${(writer.depends_on || []).join(", ") || sharedContracts.join(", ")}`,
    `produces: ${writer.produces.join(", ")}`,
    writer.first_checkpoint ? `first_checkpoint: ${writer.first_checkpoint}` : "first_checkpoint: not required for this bounded writer",
    writer.first_checkpoint
      ? "Report checkpoint evidence and actual diff/state in your receipt before completing the remaining implementation."
      : "Complete the bounded contract in this call and report the final diff/state.",
    "Do not touch forbidden_scope. Return a six-field receipt; keep bulky raw output in artifacts.",
  ].join("\n");

const runWriterOnce = async (writer, index) => {
  const receipt = await agent(buildWriterPrompt(writer), {
    label: `writer:${index}:${writer.id}`,
    schema: receiptSchema,
  });
  return { id: writer.id, index, receipt };
};

const writerLedger = writers.map((writer, index) => ({ id: writer.id, index, status: "not_started", receipt: null }));
if (barrierOpen) {
  // wave 1: producers (nothing to consume) run in parallel to completion.
  const producers = writers.flatMap((writer, index) =>
    (writer.consumes || []).length === 0 ? [{ writer, index }] : [],
  );
  const producerOutcomes = await runInWaves(
    producers.map(({ writer, index }) => () => runWriterOnce(writer, index)),
  );
  for (let i = 0; i < producers.length; i++) {
    const outcome = producerOutcomes[i];
    const entry = writerLedger.find((e) => e.id === outcome.id);
    entry.receipt = outcome.receipt;
    entry.status = outcome.receipt === null ? "failed" : outcome.receipt.status;
  }
  // later waves: consumers whose contract producers all completed.
  let iteration = 0;
  while (iteration < writers.length) {
    const batch = writers.flatMap((writer, index) => {
      if ((writer.consumes || []).length === 0) return [];
      const entry = writerLedger.find((e) => e.id === writer.id);
      if (entry.status !== "not_started") return [];
      const depsProduced = (writer.consumes || []).every((contractIndex) => {
        const producer = writers.find((w) => (w.produces_contracts || []).includes(contractIndex));
        if (!producer) return false;
        const producerEntry = writerLedger.find((e) => e.id === producer.id);
        return producerEntry.status === "completed";
      });
      return depsProduced ? [{ writer, index }] : [];
    });
    if (batch.length === 0) break;
    const outcomes = await runInWaves(batch.map(({ writer, index }) => () => runWriterOnce(writer, index)));
    for (let i = 0; i < batch.length; i++) {
      const outcome = outcomes[i];
      const entry = writerLedger.find((e) => e.id === outcome.id);
      entry.receipt = outcome.receipt;
      entry.status = outcome.receipt === null ? "failed" : outcome.receipt.status;
    }
    iteration++;
  }
}

// INVARIANT (smoke 2026-08-10): blocked receipts are hard failures (cannot reach
// integration); partial receipts mean code completed but external validation was
// blocked (e.g. missing test runner) — they proceed so integration can finish
// validation. A writer that never started is a planning failure.
const writerFailures = writerLedger
  .filter((e) => e.status === "blocked" || e.status === "failed" || e.status === "not_started")
  .map((e) => e.id);
const partialWriters = writerLedger.filter((e) => e.status === "partial").map((e) => e.id);

// A checkpoint is a gate only when the writer contract declares one. Ordinary
// bounded writers may complete in one pass without checkpoint evidence.
const entryCheckpointPassed = (entry) => {
  if (entry.status !== "completed" || entry.receipt === null) return false;
  const receipt = entry.receipt;
  const writer = writers.find((w) => w.id === entry.id);
  const checkpointRequired = writer && typeof writer.first_checkpoint === "string" && writer.first_checkpoint.trim();
  if (!checkpointRequired) return true;
  const declaredToken =
    writer.first_checkpoint.split(/[\s:/]+/)[0];
  const mentionsDeclared =
    (receipt.validation || []).some((v) => new RegExp(declaredToken, "i").test(v));
  return mentionsDeclared;
};
const checkpointFailures = barrierOpen
  ? writerLedger.filter((entry) => entry.status === "completed" && !entryCheckpointPassed(entry)).map((entry) => entry.id)
  : [];

phase("Review");
// INVARIANT: review the actual changes on the current working tree, read-only, after
// writers finished AND every declared checkpoint passed.
const reviewTarget = `${repoRoot} (changes by writers: ${writerLedger.filter((e) => e.status === "completed").map((e) => e.id).join(", ") || "none"})`;
const reviewReady = barrierOpen && writerFailures.length === 0 && checkpointFailures.length === 0;
const reviewers = reviewReady ? 2 : 0;
const reviewResults =
  reviewers > 0
    ? await parallel(
        [0, 1].map((dimension, index) => () =>
          agent(
            [
              `Read-only review of ${reviewTarget}`,
              dimension === 0 ? "Focus: correctness and integration safety." : "Focus: contract compliance and edge cases.",
              "Never modify files. Report blocking findings with file:line refs.",
            ].join("\n"),
            {
              label: `review:${index}:${dimension === 0 ? "correctness" : "contract"}`,
              schema: {
                type: "object",
                properties: {
                  verdict: { type: "string", enum: ["pass", "block"] },
                  findings: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        location: { type: "string" },
                        severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
                        description: { type: "string" },
                      },
                      required: ["location", "severity", "description"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["verdict", "findings"],
                additionalProperties: false,
              },
            },
          ),
        ),
      )
    : [];
const reviewLedger = [0, 1].map((_, index) => ({
  dimension: index === 0 ? "correctness" : "contract",
  status: reviewers === 0 ? "skipped" : reviewResults[index] === null ? "failed" : "completed",
  result: reviewers === 0 ? null : reviewResults[index],
}));
const reviewFailures = reviewLedger.filter((e) => e.status === "failed").length;
const blockingFindings = reviewLedger
  .flatMap((e) => (e.result && e.result.findings ? e.result.findings : []))
  .filter((f) => f.severity === "critical" || f.severity === "high");

phase("Integrate");
const integrationReady =
  barrierOpen &&
  writerFailures.length === 0 &&
  checkpointFailures.length === 0 &&
  reviewFailures === 0 &&
  blockingFindings.length === 0;
const integration =
  integrationReady
    ? await agent(
        [
          `Single integration of all completed writer outputs.`,
          `Repo root: ${repoRoot}`,
          `Integration contract: ${planMissing ? "n/a" : plan.integration}`,
          "Merge, resolve interface mismatches, run the declared validation, and return the final consumer status.",
          JSON.stringify(writerLedger),
        ].join("\n"),
        {
          label: "integrate-feature",
          schema: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["completed", "partial", "blocked"] },
              summary: { type: "string" },
              changes: { type: "array", items: { type: "string" } },
              validation: { type: "array", items: { type: "string" } },
              gaps: { type: "array", items: { type: "string" } },
            },
            required: ["status", "summary", "changes", "validation", "gaps"],
            additionalProperties: false,
          },
        },
      )
    : null;
const integrationMissing = integrationReady && integration === null;

return {
  plan: planMissing ? null : plan,
  writerLedger,
  writerFailures,
  partialWriters,
  checkpointFailures,
  reviewLedger,
  blockingFindings,
  integration,
  barrierOpen,
  complete:
    !planMissing &&
    barrierOpen &&
    writerFailures.length === 0 &&
    checkpointFailures.length === 0 &&
    reviewFailures === 0 &&
    blockingFindings.length === 0 &&
    !integrationMissing &&
    integration !== null &&
    integration.status === "completed",
};
