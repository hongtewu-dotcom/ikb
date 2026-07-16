---
name: ikb-source-intake
description: Ingest and preserve evidence from Elephant chats, Claude Code/Desk/Codex conversations, important documents, document or code review comments, and run artifacts. Use when an Agent needs to bring external material into ikb with scope, sensitivity, source identity, timestamps, and provenance before analysis or knowledge curation.
---

# IKB Source Intake

Use this skill to bring material into ikb without turning raw input into unverified knowledge.

## Workflow

### 1. Define the intake boundary

Identify `source_kind`, `scope`, `sensitivity`, time range, owner, and requested purpose. Supported kinds are `elephant`, `ai_conversation`, `document`, `review_comment`, `artifact`, and `manual`.

Start with the narrowest permitted range: a named person, group, project, repository, document, or period. Expand only when the evidence is insufficient.

### 2. Preserve the raw input

Keep the original file, export, transcript, or document version immutable. Record its path or URL, source message/document IDs, capture time, content hash, and access scope. Never replace raw source with a summary.

For documents, keep the original, draft versions, diff, review comments, comment resolution, and final artifact. A final document alone is not a sufficient source for writing or review learnings.

For Elephant or another internal system, use an approved export, API, or browser connector. Do not bypass login, copy credentials, or invent a missing connector. If only a pasted excerpt is available, capture it as `manual` and preserve the user-provided locator.

### 3. Normalize records

Normalize messages and comments to include:

- `source_id`, `conversation_id` or `document_id`, and `message_id` or `revision_id`;
- actor/author, role, participants, sent or modified time;
- body or content hash;
- task, repository, project, URL, file, line, or document references;
- `scope` and `sensitivity`.

Deduplicate with stable source IDs first and content hashes second. Keep a duplicate report instead of silently dropping a conflicting revision.

### 4. Use the current ikb substrate

The current repository supports file/text capture:

```bash
./bin/ikb ingest <markdown-file> --scope personal|work
./bin/ikb capture <file-or-text> --title "..." --scope personal|work
```

Add source metadata through `--source` or the imported file path. Do not mark the result `verified` during intake. The Source registry and direct conversation adapters are being added on top of this substrate; until then, report the missing adapter instead of pretending a scan succeeded.

### 5. Return an intake report

Return structured data with:

- source kind and source IDs;
- raw snapshot paths and hashes;
- imported, skipped, duplicate, and failed counts;
- normalized record references;
- scope/sensitivity decisions;
- unresolved fields and missing adapters.

Keep summaries separate from evidence references. Successful intake means the source can be found and cited; it does not mean the content is true.

## Safety gates

- Keep personal and work sources separate. Do not create cross-scope links without explicit confirmation.
- Redact secrets from prompts and derived notes; keep raw evidence local and private.
- Never infer a person's motivation or character from a small sample.
- Never create `verified` knowledge, send messages, publish documents, post CR comments, or push code during intake.
