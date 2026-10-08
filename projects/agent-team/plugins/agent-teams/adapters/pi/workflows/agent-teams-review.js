export const meta = {
  name: "agent_teams_review",
  description:
    "Read-only multi-dimension review of a frozen snapshot with finding dedup/severity calibration and one final verifier. Never modifies files.",
  phases: [
    { title: "Freeze" },
    { title: "Review" },
    { title: "Deduplicate" },
    { title: "Verify" },
  ],
};

// ADAPT: supply target, snapshot, and dimensions from context.
const target = args && typeof args.target === "string" ? args.target : "";
const snapshot = args && typeof args.snapshot === "string" ? args.snapshot : "";
if (!target) throw new Error("args.target must be supplied by context");
if (!snapshot) throw new Error("args.snapshot (commit/diff/hash) must be supplied by context");
const dimensions =
  args && Array.isArray(args.dimensions) && args.dimensions.length >= 2
    ? args.dimensions.slice(0, 4)
    : ["correctness", "architecture", "testing", "security"];

// Reviewer/verifier roles return domain schemas (findings/verdict), not the
// six-field result receipt; this exemption is documented in SKILL.md §2.
const findingSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "partial", "blocked"] },
    verdict: { type: "string", enum: ["pass", "block"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          location: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          description: { type: "string" },
          dimension: { type: "string" },
        },
        required: ["id", "location", "severity", "description", "dimension"],
        additionalProperties: false,
      },
    },
    uncovered: { type: "array", items: { type: "string" } },
  },
  required: ["status", "verdict", "findings", "uncovered"],
  additionalProperties: false,
};

phase("Freeze");
// INVARIANT: every reviewer resolves to the same frozen snapshot; refs, not copied diffs.
const reviewerContracts = dimensions.map((dimension, index) => ({
  dimension,
  prompt: [
    `goal: Review ${target} at frozen snapshot ${snapshot} for the ${dimension} dimension.`,
    `scope: Read-only inspection of ${target} at ${snapshot}, ${dimension} dimension only; never modify files.`,
    'acceptance: Complete inspection of the assigned scope with exact evidence, or an explicit no-findings result; status (execution outcome) reported separate from verdict (quality); findings use severities critical/high/medium/low with file:line or exact ref locations; uncovered scope listed in "uncovered".',
    "handoff: {status, verdict, findings, uncovered} matching the supplied schema (reviewer finding schema, exempt from the six-field receipt — see SKILL.md §2).",
  ].join("\n"),
}));

phase("Review");
const reviewResults = await parallel(
  reviewerContracts.map((contract, index) => () =>
    agent(contract.prompt, {
      label: `review:${index}:${contract.dimension}`,
      schema: findingSchema,
    }),
  ),
);

// INVARIANT: reviewer completion never implies a passing verdict; partial/blocked
// reviewers are execution failures (GOV-3), not successful reviews.
const reviews = reviewerContracts.flatMap((contract, index) => {
  const result = reviewResults[index];
  if (result === null || result.status !== "completed") return [];
  return [{ dimension: contract.dimension, result }];
});
const reviewerFailures = reviewerContracts.flatMap((contract, index) => {
  const result = reviewResults[index];
  if (result === null || result.status !== "completed") return [contract.dimension];
  return [];
});

phase("Deduplicate");
// INVARIANT: deduplicate and calibrate before any repair decision; readers all finished.
const dedup = await agent(
  [
    "goal: Deduplicate and calibrate all findings across reviewers.",
    "scope: Only the reviewer results provided below; do not start repairs and do not re-inspect the target.",
    "acceptance: Merge same location+issue findings (credit all reviewers); keep same-location different-issue separate; use the highest severity on conflicts; return a consolidated finding list and per-dimension totals.",
    "handoff: {findings, totals} matching the supplied schema.",
    "",
    JSON.stringify(reviews),
  ].join("\n"),
  {
    label: "dedup-findings",
    schema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              location: { type: "string" },
              severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
              description: { type: "string" },
              dimensions: { type: "array", items: { type: "string" } },
            },
            required: ["id", "location", "severity", "description", "dimensions"],
            additionalProperties: false,
          },
        },
        totals: {
          type: "object",
          properties: {
            critical: { type: "number" },
            high: { type: "number" },
            medium: { type: "number" },
            low: { type: "number" },
          },
          required: ["critical", "high", "medium", "low"],
        },
      },
      required: ["findings", "totals"],
      additionalProperties: false,
    },
  },
);
// INVARIANT (F3): a failed dedup is NOT "zero blockers"; it must force an inconclusive outcome.
const dedupMissing = dedup === null;
const dedupFailed = dedupMissing || dedup.findings.some((f) => !f.id || !f.location || !f.severity);
const blockers = dedupFailed ? [] : dedup.findings.filter((f) => f.severity === "critical" || f.severity === "high");

phase("Verify");
// INVARIANT (F5): one final verifier always runs against the latest snapshot and
// original blocking criteria — skipped only when the review itself could not execute.
let verification;
if (reviewerFailures.length > 0 || dedupFailed) {
  verification = {
    status: "blocked",
    verdict: "inconclusive",
    confirmed: [],
    reason: "Review could not complete: reviewers failed or consolidation failed.",
  };
} else {
  const verifierSchema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "partial", "blocked"] },
      verdict: { type: "string", enum: ["pass", "block"] },
      confirmed: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
    },
    required: ["status", "verdict", "confirmed", "reason"],
    additionalProperties: false,
  };
  verification = await agent(
    [
      `goal: Act as final verifier against snapshot ${snapshot}.`,
      `scope: Read-only independent inspection of ${target} at ${snapshot}; never modify files.`,
      blockers.length === 0
        ? "acceptance: Confirm the consolidated findings are complete and no blocking issue was missed; return verdict pass only after independent inspection."
        : "acceptance: Independently confirm or refute each consolidated blocking finding below; do not trust reviewer summaries alone.",
      "handoff: {status, verdict, confirmed, reason} matching the supplied schema.",
      `Blocking findings: ${JSON.stringify(blockers)}`,
    ].join("\n"),
    { label: "final-verifier", schema: verifierSchema },
  );
}
const verificationMissing = verification === null || verification === undefined;

// INVARIANT (F6/GOV-3): an incomplete verifier (partial/blocked) never counts as
// a passing review, even if its verdict field says pass.
let status = "completed";
if (reviewerFailures.length > 0) status = "partial";
if (dedupFailed || verificationMissing || verification.status !== "completed") status = "blocked";

return {
  snapshot,
  reviews,
  reviewerFailures,
  consolidated: dedupFailed ? null : dedup,
  blockers,
  verification: verificationMissing ? null : verification,
  status,
  verdict: verificationMissing ? "inconclusive" : verification.verdict,
  complete: status === "completed" && verification !== null && verification.verdict === "pass",
};
