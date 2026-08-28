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

### 2. Preserve the evidence boundary

Preserve the exact evidence needed for later verification; do not equate that with copying every source container. Record the owner path or URL, source message/document IDs, capture time, normalized-records hash, access scope, and the observed source boundary. Never replace cited evidence with a summary.

For local Codex, Claude Code, and Desk histories, the original tool directory is the only owner of the complete JSONL. IKB must not create a second complete copy. It stores an external locator, an append cursor and immutable normalized evidence records. A later scan reads only bytes appended after the verified cursor. If the file was truncated, the prior boundary is not a complete line, the anchor changed, or parser state is unavailable, fall back to one full rescan instead of guessing.

For remote documents, comments, explicit exports, pasted material, or any source whose original version may disappear, keep a managed immutable snapshot. The managed/external decision is based on source ownership and future availability, not file size.

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
./bin/ikb source ingest <jsonl-or-markdown-file> --kind elephant|ai_conversation|document|review_comment|artifact|manual --scope personal|work
./bin/ikb source ingest <jsonl-or-markdown-file> --kind elephant|ai_conversation|document|review_comment|artifact|manual --scope personal|work --incremental
./bin/ikb source externalize-history-raw --scope personal|work --dry-run
./bin/ikb source externalize-history-raw --scope personal|work
./bin/ikb source ingest <jsonl-or-markdown-file> --kind manual --adapter catpaw-memory --scope work
./bin/ikb source discover --adapter claude|codex|desk|elephant|all --from 2026-07-10 --to 2026-07-18 --limit 20
./bin/ikb source ingest-history --adapter claude|codex|desk|elephant --scope personal|work --from 2026-07-10 --to 2026-07-18 --limit 20 [--include-tools]
./bin/ikb source ingest-citadel <content-id> --scope work
./bin/ikb source search-citadel --keyword "<关键词>" --limit 20 --enqueue --scope work
./bin/ikb candidate discover <source-id> --scope work
./bin/ikb candidate discover-all --scope work
./bin/ikb candidate update <candidate-id> --status queued
./bin/ikb candidate resolve <candidate-id>
./bin/ikb source ingest-elephant --gid|--uid|--pid|--name|--mis <target> --limit 20 --scope work
./bin/ikb source person --name|--uid|--mis <speaker> --context-window 2 --scope work
./bin/ikb people list --scope work
./bin/ikb people update <person-id> --name "显示名" --uid <uid> --aliases "别名1,别名2"
./bin/ikb people view <person-id> --scope work --limit 100
./bin/ikb people rebuild --scope work --limit 100
./bin/ikb doctor --write-summary --compact
./bin/ikb source context <source-id> --limit 100
./bin/ikb ingest <markdown-file> --scope personal|work
./bin/ikb capture <file-or-text> --title "..." --scope personal|work
```

For a JSONL Agent conversation, normalize one object per line with `session_id`/`conversation_id`, `turn_id`/`message_id`, `role`, `content`, optional timestamp, refs, files, and participants. For documents or review comments, ingest Markdown as one cited record. Claude Code, Codex, Desk, CatPaw JSONL and direct file inputs use the same incremental contract by default: a stable logical key and record identity are compared with prior Source snapshots, only new/changed records become a new immutable delta Source, and each scan appends a state row under `ikb-data/governance/<scope>/incremental/state.jsonl` plus a `source.incremental_scan` ledger event. Use `--no-incremental` only when an intentional full snapshot is required. Claude Code, Codex, and Desk history adapters keep the complete original in the owning tool directory, default-exclude compaction/control/reasoning/token records and tool output, and persist only normalized evidence in IKB. `externalize-history-raw` may delete legacy complete copies only after raw/records integrity, origin availability and Ledger migration all pass; “already read” alone is never a deletion condition. The Elephant adapter accepts an approved local JSONL/NDJSON export through `--root` and preserves sender/participant fields; it has no default root. The bounded Elephant bridge calls the existing local `dx history` command through an authenticated Chrome CDP endpoint and requires exactly one target plus a finite limit; it parses text nodes, links, @ mentions, sender, time, mid and uuid while retaining the raw response. This is a hard read-only boundary: the operation is fixed to `history`, and the bridge must never send, reply, forward, like/react, create a group, update group information, or perform any other external write. Read both people and groups only as explicit, bounded targets; never run a targetless global scan. The Citadel adapter calls `oa-skills citadel --raw`, stores the current document and metadata as a `document` Source, and stores discussion/full-text comments and replies as a separate `review_comment` Source with parent/quote references; unchanged documents/comments are skipped and revisions/new comments are imported as deltas. `source search-citadel` calls the official `searchContent` command and preserves the raw search response as a private snapshot; search rows are only `citadel_document` Input Candidates. `candidate discover` extracts explicit Citadel URLs/content IDs from an already imported Source and keeps source/record refs. Discovery never reads the linked document automatically: only a `queued` candidate may be resolved, which then calls the bounded document/comment intake and links the resulting Source IDs back to the candidate. Run `ikb doctor` before analysis and do not build Context from a Source with integrity issues. Elephant still requires the user to have an approved, authenticated local page; no credentials or browser cookies are copied into `ikb-data`.

Source intake is append-only and incremental. Do **not** rebuild a person dossier for every discovered record, message, or Source. The intake step only records the new Source/delta and the people whose identity fields were touched. Run Artifacts may retain only intake/rebuild counters and Source IDs; never copy complete `source ingest` output, raw content, or full `people rebuild` JSON. Rebuild is a batch boundary operation:

- run it once after an intentional intake batch closes, or on the scheduled daily evidence-view job;
- skip it when the incremental scan is unchanged or no enabled person's identity is affected;
- run an ad-hoc `people view <person-id>` only when a current question needs a fresh projection;
- run the person-analysis/consolidation task weekly, or earlier when a person has at least three new direct episodes, two independent new Sources, or an explicit user request.

The dossier is a deterministic projection rebuilt from immutable Sources; it is not an append-only profile and it does not itself create Knowledge. At the consolidation checkpoint, rebuild the enabled key-person evidence views for the selected scope:

```bash
./bin/ikb people rebuild --scope work --limit 100
```

The generated `vaults/<scope>/people/<person-id>/index.md` files are observable evidence views only. They must be accompanied by a person-analysis Artifact when the task asks what a person repeatedly discusses, decides, owns, or expects; rebuilding alone is not a knowledge-extraction result.

CatPaw 远端记忆先用 `scripts/pull-catpaw-memory.py` 拉成项目内私有 JSONL 快照，再用 `source ingest --adapter catpaw-memory` 进入 Source。脚本通过统一 `token_cache.py` 获取 SSO token，插件凭证只从环境变量读取，不写入仓库：

```bash
export IKB_CATPAW_MEMORY_PLUGIN_AUTH="<本机 CatPaw 插件凭证>"
python3 scripts/pull-catpaw-memory.py --output ikb-data/staging/catpaw-memory/latest.jsonl
./bin/ikb source ingest ikb-data/staging/catpaw-memory/latest.jsonl \
  --kind manual --adapter catpaw-memory --scope work --sensitivity work-internal
```

快照旁边会生成 `latest.manifest.json`，记录拉取时间、远端总数、分页数、来源分布和 hash；原始快照、标准化记录和 `source.ingested` 事件分别留存。远端记忆是混合域输入，本轮统一按 `work/work-internal` 保存，后续形成 Knowledge 前再按内容归类。

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
- Keep raw local evidence unchanged and private; do not copy secrets into prompts, derived notes, or public examples.
- Never infer a person's motivation or character from a small sample.
- Never create `verified` knowledge, send messages, publish documents, post CR comments, or push code during intake.
