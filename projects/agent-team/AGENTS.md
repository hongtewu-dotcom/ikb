# Agent Team development

- Maintain source in `plugins/agent-teams/`; generated directories are not source.
- Reuse the host native lifecycle. Do not add a task queue, persistent execution ledger, polling service or hook-based context gates.
- Keep writer goals independently testable and write scopes disjoint; preserve explicit user execution restrictions across all phases.
- Reproduce adapter bugs with focused tests before fixing them. Run `make test` and `make validate-codex` for adapter changes; report native runtime evidence separately.
- Codex packages include only the approved adapter files. Preserve MIT attribution.
- Keep runtime sessions, credentials, internal knowledge and private evidence out of Git. Follow the repository publication policy.
