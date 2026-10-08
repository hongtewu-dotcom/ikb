# Evidence-backed delivery feedback

This is an optional local evaluation side channel, not a completion gate or a runtime.
When this Skill is actually used for an independently accepted task (including a
no-spawn decision), register the acceptance contract before doing the work and
record evidence when completing, pausing, or cancelling. Only the root agent records
its contract. Children return evidence in their existing handoff; do not register
copies of the root contract.

## Start: register before work

Read this section when opting into feedback. Load the completion section only
after validation. Children use their branch handoff and do not load this guide.

Use the existing engineering CLI at
`/Users/htwu/projects/_personal/ikb/bin/ikb`, or an explicitly configured
`AGENT_TEAM_EVAL_CLI`. Do not use the unrelated knowledge-card CLI in ~/.local/bin.
If the executable is unavailable, report `delivery_entrypoint_unavailable` briefly
and continue the user task. Do not install a dependency or start another runtime.

Get the current input schema and examples from:

```text
<cli> harness agent-team delivery schema --json
```

Write the semantic input as a local JSON file, then call:

```text
<cli> harness agent-team delivery begin --input <absolute-json-path> --json
```

The program supplies the contractRef and requestId. Preserve its machine JSON in
the tool output. Do not invent thread IDs, turn IDs, timestamps, hashes, or outcome
labels. A frozen `command_exit` criterion proves only that exact command succeeds;
use `semantic` for requirements that need independent judgment. Do not turn a
broad delivery requirement into a trivial command to obtain a pass.

## Finish: record after validation

Report the criterionId. The program finds a unique execution of
the exact frozen command in the native turn and contract time window. Only include
a callId if it was actually supplied by the host; never invent one.
Use a single exec_command per functions.exec call when the result must be associated;
batched ambiguous outputs remain unknown. A successful test does not prove deployment
or final-consumer success. Do not rerun a side effect merely to generate evidence.

```text
<cli> harness agent-team delivery record --input <absolute-json-path> --json
```

The record references contractRef and expectedRevision returned by begin or status.
It includes lifecycle and criterionId entries (optional known callId); it never includes an asserted pass.
Missing evidence is allowed and remains unknown. For an explicit continuation reuse
the returned handle; for a different goal register a new contract. Do not merge tasks
based on similar text. Read current revision with `delivery status --ref <contractRef>`
before a later correction; conflicts must be reconciled rather than blindly retried.

The existing Collector associates CLI receipts with original native root turns and
updates the report. Receipt acceptance means stored, not independently verified.
A current turn may not be collected until it ends. Any collection or grading failure
remains visible in status; it must not interrupt the authorized user work.
