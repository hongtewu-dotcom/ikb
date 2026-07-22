import { test } from "node:test";
import assert from "node:assert/strict";
import { findLoop, listLoops } from "../src/loops.ts";

test("loop contracts define required information, outputs and evidence", () => {
  const loops = listLoops();
  assert.deepEqual(loops.map((loop) => loop.id), ["inner", "mid", "outer"]);
  assert.deepEqual(loops.map((loop) => loop.ownerRole), ["ikb-harness", "ikb-harness", "ikb-harness"]);
  for (const loop of loops) {
    assert.equal(loop.inputs.some((item) => item.required), true);
    assert.equal(loop.outputs.some((item) => item.required), true);
    assert.equal(loop.evidence.length > 0, true);
    assert.equal(loop.gates.length > 0, true);
  }
  assert.equal(findLoop("inner")?.inputs.some((item) => item.key === "source_refs" && item.required), true);
  assert.equal(findLoop("mid")?.outputs.some((item) => item.key === "handoff_events" && item.required), true);
  assert.equal(findLoop("outer")?.outputs.some((item) => item.key === "pattern_candidates" && item.required), true);
});

test("loop contracts expose current implementation boundary", () => {
  assert.equal(findLoop("inner")?.implementation, "partial");
  assert.equal(findLoop("mid")?.implementation, "partial");
  assert.equal(findLoop("outer")?.implementation, "planned");
  assert.equal(findLoop("unknown"), null);
});
