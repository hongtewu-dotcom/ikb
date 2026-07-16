---
name: ikb-knowledge-curator
description: Convert evidence-backed findings from chats, Agent sessions, important documents, and review comments into Obsidian-compatible ikb knowledge candidates. Use when an Agent must normalize, deduplicate, link, review, retire, or verify knowledge while preserving sources and ledger traceability.
---

# IKB Knowledge Curator

Use this skill after intake or analysis. Keep the source evidence, create a small candidate, and make the admission decision explicit.

## Curation workflow

1. Require at least one evidence reference for every candidate. A path, message ID, document revision, review location, Artifact, Run, commit, or user confirmation can be a reference.
2. Classify `type` as `fact`, `decision`, `preference`, `playbook`, `entity`, or `goal`; choose `scope` and `sensitivity` from the evidence, never from convenience.
3. Reduce the candidate to one durable claim per note. Put applicability, boundary, counterexample, and evidence in the body.
4. Search existing verified and draft notes before creating a new one. Detect duplicate, revision, stale, and conflicting claims.
5. Create or update a `draft` Markdown note. Preserve the source reference and the original candidate in the Run or Artifact.
6. Add Obsidian relations only when the evidence supports them:
   - `derived_from`: new conclusion points to its evidence or prior conclusion;
   - `related`: same topic or complementary rule;
   - `contradicts`: two claims cannot both be current.
7. Ask for confirmation before `verified`. A verified entry must retain a source reference. Retire an old claim instead of silently overwriting it.

## Current commands

Use the deterministic CLI substrate when direct Core calls are unavailable:

```bash
./bin/ikb capture <file-or-text> --title "..." --scope personal|work
./bin/ikb ingest <markdown-file> --scope personal|work
./bin/ikb search "..." --status draft|verified
./bin/ikb knowledge relate <from-id> <to-id> --type related|derived_from|contradicts
./bin/ikb knowledge verify <id>
./bin/ikb knowledge retire <id>
```

Do not expose a long CLI sequence to the user when one Skill invocation can perform the workflow. Use CLI output as an audit trail and fallback, not as a second implementation of curation logic.

## Document and review candidates

Treat important writing and review as first-class evidence. Candidate examples:

- accepted review rule → `playbook` or `fact`;
- rejected review suggestion with reason → `decision` or `pitfall` evidence;
- repeated document structure → `playbook`;
- stable writing preference → `preference`;
- final document conclusion → `decision` with document revision reference;
- recurring reviewer concern → `risk` evidence, not automatically a universal fact.

Keep draft diff, reviewer, location, response, and verification result attached to the candidate. Do not retain only the polished final sentence.

## Obsidian rules

Generated notes use YAML frontmatter with stable `id`, `aliases`, `source_refs`, `tags`, `related`, `derived_from`, and `contradicts`. Use `[[id|title]]` links. `related` and `contradicts` are reciprocal; `derived_from` points from the new note to the source note.

Keep personal and work Vaults isolated. Cross-scope links require explicit confirmation. Do not link every search hit: retrieval is not a semantic relation.

## Output contract

Return:

```yaml
created: knowledge IDs and paths
updated: knowledge IDs and changed fields
relations: relation type, source ID, target ID, and whether reciprocal
evidence_refs: sources used for the decision
blocked: candidates waiting for source, conflict resolution, or human confirmation
next_action: verify, clarify, revise, retire, or leave draft
```

Never mark a candidate `verified` merely because an Agent generated it. Never overwrite a verified claim without a revision and an event in the ledger.
