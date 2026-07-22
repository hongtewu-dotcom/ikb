import { test } from "node:test";
import assert from "node:assert/strict";
import { findGate, listGates } from "../src/gates.ts";
import { canonicalAgentId, listAgentRoles, validateAgentInvocation } from "../src/roles.ts";

test("agent role manifests expose stable ids, Chinese names, gates and skills", () => {
  const roles = listAgentRoles();
  assert.deepEqual(roles.map((role) => role.id), [
    "ikb-harness",
    "ikb-intake",
    "ikb-analyst",
    "ikb-curator",
    "ikb-operator",
    "ikb-verifier",
  ]);
  assert.deepEqual(roles.map((role) => role.name), [
    "任务总管",
    "资料采集员",
    "证据分析员",
    "知识策展员",
    "工作执行员",
    "验收审计员",
  ]);
  assert.deepEqual(roles.find((role) => role.id === "ikb-operator")?.gates, ["G4", "G5", "G6"]);
  assert.equal(roles.find((role) => role.id === "ikb-intake")?.skills.includes("ikb-source-intake"), true);
});

test("role invocation validates allowed skills and keeps legacy aliases readable", () => {
  assert.equal(canonicalAgentId("manual"), "ikb-operator");
  const valid = validateAgentInvocation("manual", ["draft", "cr"]);
  assert.equal(valid.ok, true);
  assert.equal(valid.agentId, "ikb-operator");
  assert.deepEqual(valid.skills, ["document", "cr"]);

  const invalid = validateAgentInvocation("ikb-intake", ["coding"]);
  assert.equal(invalid.ok, false);
  assert.match(invalid.issues[0], /not allowed/);

  const wrongTaskType = validateAgentInvocation("ikb-intake", [], "coding");
  assert.equal(wrongTaskType.ok, false);
  assert.match(wrongTaskType.issues[0], /does not accept Task type/);
});

test("gate catalog exposes current implementation status", () => {
  const gates = listGates();
  assert.deepEqual(gates.map((gate) => gate.id), ["G0", "G1", "G2", "G3", "G4", "G5", "G6"]);
  assert.equal(findGate("G1")?.implementation, "hard");
  assert.equal(findGate("G4")?.implementation, "partial");
  assert.equal(findGate("G9"), null);
});
