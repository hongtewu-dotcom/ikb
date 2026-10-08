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

// Forward the existing brief verbatim: a planner summary must not erase user
// constraints. Each phase still owns only its assigned scope, not the full brief.
const taskConstraints = [
  "Task brief and user constraints (unchanged across phases):",
  brief,
  "Apply these constraints within your assigned phase and scope; this brief does not grant ownership of other branches.",
  "Explicit command, file, and side-effect restrictions override generic instructions to validate or repair. Preserve exact commands and environment variables; do not substitute inline checks, imports, or other tools to bypass a restriction. Generated files and caches count as writes.",
  "If a required check cannot run within these limits, report the gap rather than broadening permission. Do not hide a violation by deleting its evidence or claiming functional success implies compliance.",
].join("\n");

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

// Shared instruction text keeps planning and live writer prompts aligned.
// These are prompt boundaries for the existing workflow, not runtime gates.
const leafWorkRules = [
  "Decompose each writer into one independently testable behavior with a precise, stable responsibility and module/file-bounded write_scope.",
  "Freeze shared contracts before dependent writers start. Stop with status blocked if continuing requires a new goal, wider write_scope, a changed frozen contract, an unauthorized side effect, or repeated failure without new evidence.",
  "Writers are leaf tasks and do not delegate to child agents. A continuation or follow-up may continue only the same responsibility and must not accumulate new goals.",
  "Declare first_checkpoint only when high risk or uncertain ownership makes intermediate inspection useful; omit it for ordinary bounded work. Routine baseline tests are not first_checkpoint.",
  "Within its frozen boundary, a writer may implement, run targeted validation, and repair failures caused by its own changes.",
  "Use status partial only when implementation is complete but external validation remains unavailable; unfinished implementation and the stop conditions above are blocked.",
];
const checkpointRequired = (writer) =>
  Boolean(writer && typeof writer.first_checkpoint === "string" && writer.first_checkpoint.trim());

phase("Plan");
const plan = await agent(
  [
    `goal: Plan the feature below into bounded disjoint write streams; execution runs at most ${maxConcurrency} writers concurrently.`,
    `scope: Planning only within repo root ${repoRoot}; do not modify files.`,
    `acceptance: ${[
      "Output writer decomposition (module, owned files), shared contracts that must be frozen first, and an integration/consumer step.",
      "Every writer carries goal/scope/acceptance plus write_scope/forbidden_scope/depends_on/produces; handoff is the fixed six-field receipt added by the spawner.",
      "Each shared_contract is identified by its 0-based index in shared_contracts; fill consumes with indices the writer consumes and produces_contracts with indices it produces; every contract index must be owned by at least one writer; depends_on names the same consumed contracts in words, while consumes is the scheduling source of truth.",
      ...leafWorkRules,
    ].join(" ")}`,
    "handoff: {writers, shared_contracts, integration} matching the supplied schema.",
    "",
    taskConstraints,
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
  const indicesInRange = writers.every((writer) =>
    [...(writer.consumes || []), ...(writer.produces_contracts || [])].every(
      (contractIndex) => Number.isInteger(contractIndex) && contractIndex >= 0 && contractIndex < sharedContracts.length,
    ),
  );
  barrierOpen = disjoint && forbiddenCoversPeers && sharedContractsFrozen && indicesInRange && writers.length > 0;
  if (!barrierOpen) {
    const frozen = await agent(
      [
        "goal: Repair the writer decomposition below; it is not barrier-safe (overlapping write_scope, forbidden_scope not covering peers, missing acceptance, or out-of-range contract indices).",
        "scope: Planning metadata only; do not modify repository files.",
        "acceptance: Redistribute ownership so every file has one owner, each forbidden_scope covers all peer write scopes, every writer has acceptance, and every consumes/produces_contracts index stays in range; keep the shared contract list explicit.",
        "handoff: {writers, shared_contracts} matching the supplied schema.",
        "",
        taskConstraints,
        JSON.stringify({ writers, shared_contracts: sharedContracts }),
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
      const stillInRange = writers.every((writer) =>
        [...(writer.consumes || []), ...(writer.produces_contracts || [])].every(
          (contractIndex) => Number.isInteger(contractIndex) && contractIndex >= 0 && contractIndex < sharedContracts.length,
        ),
      );
      barrierOpen = stillDisjoint && stillCovers && stillFrozen && stillInRange && writers.length > 0;
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
// Scheduling keys on consumes/produces_contracts indices (the source of truth);
// depends_on is the human-readable name list for the same consumed contracts.
const buildWriterPrompt = (writer) => {
  const consumedContracts = (writer.consumes || [])
    .map((contractIndex) => sharedContracts[contractIndex])
    .filter((contract) => typeof contract === "string");
  const declaredDepends = (writer.depends_on || []).filter((entry) => String(entry).trim());
  const frozenDeps = [...declaredDepends, ...consumedContracts];
  return [
    `goal: ${writer.goal}`,
    `scope: ${writer.scope}`,
    `acceptance: ${(writer.acceptance || []).join("; ")}`,
    `write_scope: ${writer.write_scope.join(", ")}`,
    `forbidden_scope: ${writer.forbidden_scope.join(", ")}`,
    `depends_on (frozen contracts): ${frozenDeps.join(", ") || "none"}`,
    `produces: ${writer.produces.join(", ")}`,
    ...leafWorkRules,
    taskConstraints,
    checkpointRequired(writer) ? `first_checkpoint: ${writer.first_checkpoint}` : "first_checkpoint: not required for this bounded writer",
    checkpointRequired(writer)
      ? "Stop at this declared checkpoint. Do not complete the remaining implementation; report the checkpoint evidence and actual diff/state, then return blocked while awaiting main-agent acceptance."
      : "Do not pause for an intermediate checkpoint. Complete implementation, targeted validation, and any in-scope repair in this call, then report the final diff/state.",
    "handoff: six-field receipt (status/summary/evidence/changes/validation/gaps); do not touch forbidden_scope; keep bulky raw output in artifacts.",
  ].join("\n");
};

const runWriterOnce = async (writer, index) => {
  const receipt = await agent(buildWriterPrompt(writer), {
    label: `writer:${index}:${writer.id}`,
    schema: receiptSchema,
  });
  // A declared first checkpoint is an intermediate handoff. This workflow has
  // no main-agent acceptance input, so a writer cannot release dependents by
  // self-reporting completed or by echoing checkpoint text in validation.
  const status = receipt === null ? "failed" : checkpointRequired(writer) ? "blocked" : receipt.status;
  return { id: writer.id, index, receipt, status };
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
    const entry = writerLedger[outcome.index];
    entry.receipt = outcome.receipt;
    entry.status = outcome.status;
  }
  // later waves: consumers whose contract producers all completed.
  let iteration = 0;
  while (iteration < writers.length) {
    const batch = writers.flatMap((writer, index) => {
      if ((writer.consumes || []).length === 0) return [];
      const entry = writerLedger[index];
      if (entry.status !== "not_started") return [];
      const depsProduced = (writer.consumes || []).every((contractIndex) => {
        const producerIndex = writers.findIndex((w) => (w.produces_contracts || []).includes(contractIndex));
        if (producerIndex === -1) return false;
        // partial producers unblock consumers too: their code completed and
        // only external validation was blocked (see the invariant below);
        // requiring "completed" would deadlock every downstream consumer.
        const producerStatus = writerLedger[producerIndex].status;
        return producerStatus === "completed" || producerStatus === "partial";
      });
      return depsProduced ? [{ writer, index }] : [];
    });
    if (batch.length === 0) break;
    const outcomes = await runInWaves(batch.map(({ writer, index }) => () => runWriterOnce(writer, index)));
    for (let i = 0; i < batch.length; i++) {
      const outcome = outcomes[i];
      const entry = writerLedger[outcome.index];
      entry.receipt = outcome.receipt;
      entry.status = outcome.status;
    }
    iteration++;
  }
}

// INVARIANT (smoke 2026-08-10): blocked receipts are hard failures (cannot reach
// integration); partial receipts mean code completed but external validation was
// blocked (e.g. missing test runner) — ordinary writers proceed so integration can
// finish validation. A checkpointed writer is overridden to blocked until the
// parent accepts its intermediate handoff. A writer that never started is a
// planning failure.
const writerFailures = writerLedger
  .filter((e) => e.status === "blocked" || e.status === "failed" || e.status === "not_started")
  .map((e) => e.id);
const partialWriters = writerLedger.filter((e) => e.status === "partial").map((e) => e.id);

// A checkpointed writer always needs a later main-agent acceptance. This
// preset has no acceptance signal, so every started checkpoint writer remains
// blocked and visible in checkpointFailures, independent of receipt status or
// self-reported validation text. The parent can inspect the handoff and dispatch
// the remaining work with the existing agent call after accepting it.
const checkpointFailures = barrierOpen
  ? writerLedger
      .filter((entry) => checkpointRequired(writers[entry.index]) && entry.status !== "not_started")
      .map((entry) => entry.id)
  : [];

phase("Review");
// INVARIANT: review the actual changes on the current working tree, read-only, after
// writers finished AND no declared checkpoint is waiting for parent acceptance.
const reviewTarget = `${repoRoot} (changes by writers: ${writerLedger.filter((e) => e.status === "completed").map((e) => e.id).join(", ") || "none"})`;
const reviewReady = barrierOpen && writerFailures.length === 0 && checkpointFailures.length === 0;
const reviewers = reviewReady ? 2 : 0;
const reviewResults =
  reviewers > 0
    ? await parallel(
        [0, 1].map((dimension, index) => () =>
          agent(
            [
              `goal: Read-only review of ${reviewTarget}.`,
              `scope: ${dimension === 0 ? "Correctness and integration safety" : "Contract compliance and edge cases"} of the writer changes only; never modify files.`,
              "acceptance: Check behavior and compliance with the original constraints, including actual command history and generated files. Report explicit constraint violations as blocking high-severity findings with evidence; missing evidence is a gap, not proof of compliance.",
              taskConstraints,
              `Frozen writer contracts: ${JSON.stringify(writers)}`,
              `Writer evidence (verify relevant claims): ${JSON.stringify(writerLedger)}`,
              "handoff: {verdict, findings} matching the supplied schema (reviewer finding schema, exempt from the six-field receipt — see SKILL.md §2).",
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
          "goal: Single integration of all completed writer outputs.",
          `scope: Repo root ${repoRoot}; only files within the completed writers' write_scope may be touched.`,
          `acceptance: Merge, resolve interface mismatches, run the declared validation, and return the final consumer status. Integration contract: ${planMissing ? "n/a" : plan.integration}`,
          "handoff: six-field receipt (status/summary/evidence/changes/validation/gaps) matching the supplied schema.",
          "",
          taskConstraints,
          `Frozen writer contracts: ${JSON.stringify(writers)}`,
          "Verify both functional acceptance and command/file/side-effect constraints. Return partial with gaps when compliance cannot be established; report known violations as blocked, even when functional tests pass.",
          JSON.stringify(writerLedger),
        ].join("\n"),
        {
          label: "integrate-feature",
          schema: receiptSchema,
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
