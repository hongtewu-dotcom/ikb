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

The Writer Barrier stays closed until every writer's contract is frozen and
write scopes are disjoint (one owner per file).
