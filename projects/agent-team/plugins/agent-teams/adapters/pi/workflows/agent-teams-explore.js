export const meta = {
  name: "agent_teams_explore",
  description:
    "Cross-repo / multi-source read-only evidence gathering with structured receipts, complete coverage ledger, and one synthesis. No file changes.",
  phases: [{ title: "Preflight" }, { title: "Explore" }, { title: "Synthesize" }],
};

// ADAPT: validate sources before fan-out. Source count is unbounded; execution
// proceeds in waves of at most four branches.
const sources = args && Array.isArray(args.sources) ? args.sources : [];
const maxConcurrency =
  args && typeof args.concurrency === "number"
    ? Math.min(4, Math.max(1, args.concurrency))
    : 4;
const question =
  args && typeof args.question === "string" ? args.question : "";
if (!question) throw new Error("args.question must be supplied by context");
if (sources.length === 0) throw new Error("args.sources must not be empty");

// The receipt shape mirrors policies/result-receipt.schema.json.
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

phase("Preflight");
// INVARIANT: freeze each branch contract before any exploration starts.
const contracts = sources.map((source, index) => ({
  id: String(source.id || `source-${index}`),
  goal: `Gather read-only evidence from this source for: ${question}`,
  scope: `Read only ${String(source.path || source.ref || source)}; never modify files.`,
  acceptance: [
    "Return verified claims with exact refs (path/commit/hash/line).",
    "Do not invent findings missing from the source.",
    "Return a concise six-field receipt and keep bulky raw output in artifacts.",
  ],
  handoff: "status/summary/evidence/changes/validation/gaps",
}));

phase("Explore");
const runInWaves = async (tasks) => {
  const outcomes = [];
  for (let offset = 0; offset < tasks.length; offset += maxConcurrency) {
    outcomes.push(...(await parallel(tasks.slice(offset, offset + maxConcurrency))));
  }
  return outcomes;
};
const results = await runInWaves(
  contracts.map((contract, index) => () =>
    agent(
      [
        `goal: ${contract.goal}`,
        `scope: ${contract.scope}`,
        `acceptance: ${contract.acceptance.join("; ")}`,
        `handoff: ${contract.handoff}`,
        "",
        "Raw tool output stays in your working context; return only the receipt.",
      ].join("\n"),
      { label: `explore:${index}:${contract.id}`, schema: receiptSchema },
    ),
  ),
);

// INVARIANT: preserve every intended identity before filtering.
const ledger = contracts.map((contract, index) => ({
  id: contract.id,
  status: results[index] === null ? "failed" : results[index].status,
  receipt: results[index],
}));
const failures = ledger.filter((entry) => entry.status === "failed").map((entry) => entry.id);
const blocked = ledger.filter((entry) => entry.status === "blocked").map((entry) => entry.id);

phase("Synthesize");
const synthesis = await agent(
  [
    `Synthesize the complete exploration ledger below for: ${question}`,
    "Distinguish covered sources from failed/blocked/missing coverage; do not invent results.",
    "Return a receipt-shaped object with a consolidated summary and merged gaps.",
    JSON.stringify(ledger),
  ].join("\n"),
  {
    label: "synthesize-exploration",
    schema: {
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
    },
  },
);
const synthesisMissing = synthesis === null;

return {
  question,
  ledger,
  failures,
  blocked,
  synthesis: synthesisMissing ? null : synthesis,
  complete: failures.length === 0 && blocked.length === 0 && !synthesisMissing,
};
