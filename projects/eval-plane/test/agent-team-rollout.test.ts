import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  AGENT_TEAM_CAMPAIGN_SAMPLES_SCHEMA,
  AGENT_TEAM_ROLLOUT_TELEMETRY_SCHEMA,
  collectAgentTeamRollouts,
  runAgentTeamCampaign,
} from "../src/agent-team-rollout.ts";
import {
  CAMPAIGN_MANIFEST_SCHEMA,
  computeCampaignCohortHash,
} from "../src/campaign-evaluator.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

interface SyntheticTurn {
  turnId: string;
  startedAt: string;
  completedAt?: string;
  cumulativeTokens: number;
  calls?: string[];
}

function developerCatalog(installed: boolean): string {
  if (!installed) return "## Skills\n- unrelated: unrelated skill";
  return [
    "### Skill roots",
    "- `r3` = `/Users/demo/.codex/plugins/cache/ikb-agent-team/agent-teams/2.0.0/skills`",
    "### Available skills",
    "- agent-teams:agent-team-delegate: delegate (file: r3/agent-team-delegate/SKILL.md)",
    "- agent-teams:agent-team-feature: feature (file: r3/agent-team-feature/SKILL.md)",
    "- agent-teams:agent-team-review: review (file: r3/agent-team-review/SKILL.md)",
  ].join("\n");
}

function writeRootRollout(path: string, options: {
  threadId: string;
  installed: boolean;
  turns: SyntheticTurn[];
}): void {
  const rows: unknown[] = [{
    timestamp: options.turns[0].startedAt,
    type: "session_meta",
    payload: {
      id: options.threadId,
      session_id: options.threadId,
      timestamp: options.turns[0].startedAt,
      cli_version: "0.149.1",
      cwd: "/Users/demo/projects/repo",
      source: "exec",
      thread_source: "user",
    },
  }];
  let previousTotal = 0;
  for (const turn of options.turns) {
    rows.push(
      { timestamp: turn.startedAt, type: "event_msg", payload: { type: "task_started", turn_id: turn.turnId } },
      {
        timestamp: turn.startedAt,
        type: "response_item",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: developerCatalog(options.installed) }] },
      },
      {
        timestamp: turn.startedAt,
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "TOP SECRET PROMPT MUST NOT PERSIST" }] },
      },
      {
        timestamp: turn.startedAt,
        type: "turn_context",
        payload: {
          turn_id: turn.turnId,
          model: "gpt-5.6-sol",
          effort: "max",
          multi_agent_version: "v2",
          sandbox_policy: { type: "read-only" },
          permission_profile: { type: "managed" },
          collaboration_mode: { mode: "default" },
        },
      },
    );
    for (const [index, name] of (turn.calls ?? []).entries()) {
      rows.push({
        timestamp: new Date(Date.parse(turn.startedAt) + 100 + index).toISOString(),
        type: "response_item",
        payload: { type: "function_call", name, call_id: `call-${turn.turnId}-${index}`, arguments: "{}" },
      });
    }
    previousTotal += turn.cumulativeTokens;
    rows.push({
      timestamp: new Date(Date.parse(turn.startedAt) + 500).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: previousTotal - 10,
            cached_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
            total_tokens: previousTotal,
          },
        },
      },
    });
    if (turn.completedAt) {
      rows.push({
        timestamp: turn.completedAt,
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: turn.turnId,
          duration_ms: Date.parse(turn.completedAt) - Date.parse(turn.startedAt),
          last_agent_message: "SECRET MODEL OUTPUT MUST NOT PERSIST",
        },
      });
    }
  }
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function writeChildRollout(path: string, options: {
  rootThreadId: string;
  childThreadId: string;
  turnId: string;
  startedAt: string;
  completedAt: string;
  tokens: number;
}): void {
  const rows = [
    {
      timestamp: options.startedAt,
      type: "session_meta",
      payload: {
        id: options.childThreadId,
        session_id: options.rootThreadId,
        timestamp: options.startedAt,
        cli_version: "0.149.1",
        cwd: "/Users/demo/projects/repo",
        thread_source: "subagent",
        subagent_history_start_ordinal: 2,
        source: { subagent: { thread_spawn: { parent_thread_id: options.rootThreadId, depth: 1, agent_path: "/root/reader", agent_role: "explorer" } } },
      },
    },
    {
      timestamp: options.startedAt,
      type: "session_meta",
      payload: { id: options.rootThreadId, session_id: options.rootThreadId, timestamp: options.startedAt, cli_version: "0.149.1", cwd: "/Users/demo/projects/repo", source: "exec", thread_source: "user" },
    },
    { timestamp: options.startedAt, type: "event_msg", payload: { type: "task_started", turn_id: options.turnId } },
    {
      timestamp: options.startedAt,
      type: "turn_context",
      payload: { turn_id: options.turnId, model: "gpt-5.6-sol", effort: "max", multi_agent_version: "v2", sandbox_policy: { type: "read-only" }, permission_profile: { type: "managed" }, collaboration_mode: { mode: "default" } },
    },
    { timestamp: new Date(Date.parse(options.startedAt) + 100).toISOString(), type: "response_item", payload: { type: "function_call", name: "send_message", call_id: "child-message", arguments: "{}" } },
    {
      timestamp: new Date(Date.parse(options.startedAt) + 200).toISOString(),
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: options.tokens - 5, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: options.tokens } } },
    },
    { timestamp: options.completedAt, type: "event_msg", payload: { type: "task_complete", turn_id: options.turnId, duration_ms: Date.parse(options.completedAt) - Date.parse(options.startedAt), last_agent_message: "child secret" } },
  ];
  writeFileSync(path, `${rows.map((row, ordinal) => JSON.stringify({ ...row, ordinal })).join("\n")}\n`);
}

test("collects completed root turns, aggregates descendant cost, and persists metadata only", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-agent-team-rollout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  const artifacts = join(root, "artifacts");
  mkdirSync(sessions, { recursive: true });
  writeRootRollout(join(sessions, "root.jsonl"), {
    threadId: "root-thread",
    installed: true,
    turns: [
      { turnId: "root-turn-1", startedAt: "2026-08-26T10:00:00.000Z", completedAt: "2026-08-26T10:00:01.000Z", cumulativeTokens: 100, calls: ["spawn_agent", "wait_agent"] },
      { turnId: "root-turn-2", startedAt: "2026-08-26T10:01:00.000Z", completedAt: "2026-08-26T10:01:02.000Z", cumulativeTokens: 80 },
    ],
  });
  writeChildRollout(join(sessions, "child.jsonl"), {
    rootThreadId: "root-thread",
    childThreadId: "child-thread",
    turnId: "child-turn",
    startedAt: "2026-08-26T10:00:00.200Z",
    completedAt: "2026-08-26T10:00:00.800Z",
    tokens: 50,
  });

  const first = collectAgentTeamRollouts({
    sessionRoots: [sessions],
    outputRoot: artifacts,
    from: "2026-08-26T00:00:00.000Z",
    to: "2026-08-27T00:00:00.000Z",
    skillFilter: "installed",
    expectedInstallation: { marketplace: "ikb-agent-team", plugin: "agent-teams", version: "2.0.0" },
  });
  const second = collectAgentTeamRollouts({
    sessionRoots: [sessions],
    outputRoot: artifacts,
    from: "2026-08-26T00:00:00.000Z",
    to: "2026-08-27T00:00:00.000Z",
    skillFilter: "installed",
    expectedInstallation: { marketplace: "ikb-agent-team", plugin: "agent-teams", version: "2.0.0" },
  });

  assert.equal(first.status, "ready");
  assert.equal(first.matchedRootTurns, 2);
  assert.equal(first.persisted, 2);
  assert.equal(second.reused, 2);
  const firstTurn = first.artifacts.find((item) => item.subjectRef.endsWith("/root-turn-1"));
  assert.ok(firstTurn);
  assert.equal(existsSync(firstTurn.persistence.path), true);
  const bytes = readFileSync(firstTurn.persistence.path, "utf8");
  const telemetry = JSON.parse(bytes);
  assert.equal(telemetry.schema, AGENT_TEAM_ROLLOUT_TELEMETRY_SCHEMA);
  assert.equal(telemetry.cost.totalTokens, 150);
  assert.equal(telemetry.execution.childThreads, 1);
  assert.equal(telemetry.collaboration.spawnAgent, 1);
  assert.equal(telemetry.collaboration.sendMessage, 1);
  assert.equal(telemetry.completeness.tokens, true);
  assert.equal(bytes.includes("TOP SECRET"), false);
  assert.equal(bytes.includes("SECRET MODEL"), false);
  assert.equal(bytes.includes(sessions), false);
  const secondTurn = JSON.parse(readFileSync(first.artifacts.find((item) => item.subjectRef.endsWith("/root-turn-2"))!.persistence.path, "utf8"));
  assert.equal(secondTurn.cost.totalTokens, 80);
  assert.equal(secondTurn.execution.childThreads, 0);
});

test("does not turn an active or token-incomplete turn into campaign evidence", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-agent-team-incomplete-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeRootRollout(join(sessions, "active.jsonl"), {
    threadId: "active-thread",
    installed: true,
    turns: [{ turnId: "active-turn", startedAt: "2026-08-26T10:00:00.000Z", cumulativeTokens: 10 }],
  });

  const result = collectAgentTeamRollouts({
    sessionRoots: [sessions],
    outputRoot: join(root, "artifacts"),
    from: "2026-08-26T00:00:00.000Z",
    to: "2026-08-27T00:00:00.000Z",
    skillFilter: "installed",
    expectedInstallation: { marketplace: "ikb-agent-team", plugin: "agent-teams", version: "2.0.0" },
  });

  assert.equal(result.matchedRootTurns, 0);
  assert.equal(result.skippedIncomplete, 1);
  assert.equal(result.artifacts.length, 0);
});

test("ikb harness agent-team collect is the scheduled final consumer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-agent-team-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  const home = join(root, "ikb-home");
  mkdirSync(sessions, { recursive: true });
  writeRootRollout(join(sessions, "root.jsonl"), {
    threadId: "cli-thread",
    installed: true,
    turns: [{ turnId: "cli-turn", startedAt: "2026-08-26T10:00:00.000Z", completedAt: "2026-08-26T10:00:01.000Z", cumulativeTokens: 42 }],
  });
  const ikbRoot = resolve(import.meta.dirname, "../../..");
  const result = spawnSync(join(ikbRoot, "bin", "ikb"), [
    "harness", "agent-team", "collect",
    "--sessions-root", sessions,
    "--from", "2026-08-26T00:00:00.000Z",
    "--to", "2026-08-27T00:00:00.000Z",
    "--home", home,
    "--json",
  ], { cwd: ikbRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "ready");
  assert.equal(report.matchedRootTurns, 1);
  assert.equal(existsSync(report.artifacts[0].persistence.path), true);
});

test("converts evidence-labelled A/B turns into Campaign observations and the final aggregate report", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-agent-team-campaign-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeRootRollout(join(sessions, "baseline.jsonl"), {
    threadId: "baseline-thread",
    installed: false,
    turns: [{ turnId: "baseline-turn", startedAt: "2026-08-26T10:00:00.000Z", completedAt: "2026-08-26T10:00:01.000Z", cumulativeTokens: 200, calls: ["spawn_agent"] }],
  });
  writeRootRollout(join(sessions, "candidate.jsonl"), {
    threadId: "candidate-thread",
    installed: true,
    turns: [{ turnId: "candidate-turn", startedAt: "2026-08-26T11:00:00.000Z", completedAt: "2026-08-26T11:00:01.000Z", cumulativeTokens: 100 }],
  });
  writeChildRollout(join(sessions, "baseline-child.jsonl"), {
    rootThreadId: "baseline-thread",
    childThreadId: "baseline-child-thread",
    turnId: "baseline-child-turn",
    startedAt: "2026-08-26T10:00:00.200Z",
    completedAt: "2026-08-26T10:00:00.800Z",
    tokens: 20,
  });
  writeFileSync(join(sessions, "unrelated-broken.jsonl"), `${JSON.stringify({ timestamp: "2026-08-26T09:00:00.000Z", type: "session_meta", payload: { id: "unrelated-thread", session_id: "unrelated-thread" } })}\nnot-json\n`);

  const probe = collectAgentTeamRollouts({
    sessionRoots: [sessions],
    outputRoot: join(root, "probe"),
    from: "2026-08-26T00:00:00.000Z",
    to: "2026-08-27T00:00:00.000Z",
    skillFilter: "any",
  });
  const controlHashes = probe.artifacts.map((item) => JSON.parse(readFileSync(item.persistence.path, "utf8")).runtime.controlHash);
  assert.equal(new Set(controlHashes).size, 1);

  const caseHash = hash("short-independent-read");
  const campaignId = "agent-team-controlled-r1";
  const manifest = {
    schema: CAMPAIGN_MANIFEST_SCHEMA,
    campaignId,
    campaignVersion: "v1",
    dataset: { kind: "sealed_holdout", cohortHash: computeCampaignCohortHash([caseHash]), caseCount: 1, trialsPerCase: 1, strata: [{ id: "routing", caseCount: 1 }], minReportGroupSize: 2 },
    baseline: { id: "baseline", harnessRef: "artifact://agent-team/native", configHash: hash("native") },
    candidate: { id: "candidate", harnessRef: "artifact://agent-team/2.0.0", configHash: hash("2.0.0") },
    controlHash: controlHashes[0],
    policy: { minPairedCases: 1, maxCandidateL1Failures: 0, minL3Improvement: 0.1, confidenceLevel: 0.95, maxStratumL3Regression: 0, maxTokenIncreaseRatio: 0.2, maxWallTimeIncreaseRatio: 0.2, maxManualInterventionIncrease: 0 },
  };
  const samples = {
    schema: AGENT_TEAM_CAMPAIGN_SAMPLES_SCHEMA,
    campaignId,
    samples: [
      { variantId: "baseline", rootThreadId: "baseline-thread", turnId: "baseline-turn", caseHash, trial: 1, stratum: "routing", expectedSkillState: "absent", l1Passed: true, l3Status: "pass", manualInterventions: 0, expectedSpawn: "no_spawn", writerConflict: "unknown", reviewSnapshotDrift: "unknown", parentChildDuplicateReads: null, outcomeEvidenceRef: "artifact://agent-team-eval/baseline" },
      { variantId: "candidate", rootThreadId: "candidate-thread", turnId: "candidate-turn", caseHash, trial: 1, stratum: "routing", expectedSkillState: "loaded", l1Passed: true, l3Status: "pass", manualInterventions: 0, expectedSpawn: "no_spawn", writerConflict: "unknown", reviewSnapshotDrift: "unknown", parentChildDuplicateReads: null, outcomeEvidenceRef: "artifact://agent-team-eval/candidate" },
    ],
  };
  const manifestPath = join(root, "manifest.json");
  const samplesPath = join(root, "samples.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(samplesPath, `${JSON.stringify(samples, null, 2)}\n`);

  const result = runAgentTeamCampaign({
    manifestPath,
    samplesPath,
    sessionRoots: [sessions],
    telemetryRoot: join(root, "telemetry"),
    resultRoot: join(root, "results"),
    observationsRoot: join(root, "observations"),
    campaignReportRoot: join(root, "campaign-reports"),
  });

  assert.equal(result.campaign.report.decision, "inconclusive");
  assert.equal(result.monitoring.falsePositiveSpawns, 1);
  assert.equal(result.monitoring.falseNegativeSpawns, 0);
  assert.equal(result.monitoring.qualityLabelled, 2);
  assert.equal(existsSync(result.observationsPersistence.path), true);
  const observations = JSON.parse(readFileSync(result.observationsPersistence.path, "utf8"));
  assert.deepEqual(observations.observations.map((item: { l2: { tokens: number } }) => item.l2.tokens), [220, 100]);
  assert.equal(JSON.stringify(result).includes(caseHash), false);
});
