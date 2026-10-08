# Reusable branch prompt template (Pi)

Attach this template to every `agent()` call that delegates real work.
Fill the bracketed fields from the frozen contract; never copy the parent
conversation into the branch. The receipt shape matches
`../policies/result-receipt.schema.json` and is enforced by the `schema`
option on the agent call.

```text
goal: [one concrete outcome]

scope: [exact files, sources, or questions in scope]
acceptance:
- [mechanically checkable condition 1]
- [mechanically checkable condition 2]

handoff:
Return one JSON object with exactly:
  status: "completed" | "partial" | "blocked"
  summary: concise conclusion
  evidence: [path, commit, hash, run id, or test ref]
  changes: [file or artifact you produced/modified]
  validation: [check you ran and its outcome]
  gaps: [uncovered scope or open unknown]

Rules:
- Do not widen scope to chase non-blocking findings.
- Raw tool output stays in your working context; return only the receipt.
- If blocked, put a concrete reason and one suggested next action in gaps.
```

## Writer variant

For writing branches only, add before the rules:

```text
write_scope: [files/directories you may modify]
forbidden_scope: [explicitly out of bounds, including all other writers' write_scope]
depends_on: [frozen contracts/interfaces you consume]
produces: [outputs the integration step consumes]
first_checkpoint: [optional failing test or minimum diff when intermediate inspection is materially safer]
```

Each writer is a leaf task for one independently testable behavior, with a
stable responsibility and precise module/file scope. Do not delegate child
agents. The Writer Barrier stays closed until shared contracts are frozen and
write scopes are disjoint (one owner per file).

```text
Writer execution:
- Implement only the frozen goal and write_scope.
- Run the narrowest relevant acceptance validation after implementation.
- If validation fails because of your changes, repair within write_scope and
  rerun while each attempt uses new evidence. Do not repair unrelated or
  pre-existing failures.
- Stop with status blocked if continuing needs a new goal, a wider write_scope,
  a changed shared contract, an unauthorized side effect, or a repeated failure
  without new evidence.
- Use status partial only when implementation is complete but external
  validation remains unavailable; unfinished implementation is blocked.
- A continuation or follow-up may continue only this same responsibility and
  must preserve the original goal, write_scope, and contracts. Do not add goals.
- Declare first_checkpoint only when high risk or uncertain ownership makes
  intermediate inspection useful. If declared, stop there, return blocked with
  checkpoint evidence and actual diff/state, and wait for parent acceptance
  before completing the remaining implementation. An ordinary bounded writer
  needs no checkpoint and should complete implementation, validation, and
  in-scope repairs in this call.
```

Carry applicable user command/file/side-effect limits verbatim in scope and acceptance. Generic validation permission cannot override them; generated files and caches are writes. Preserve validation ownership and report prohibited or unavailable checks as gaps.
