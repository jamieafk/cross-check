# fable-check — project context

Cross-agent skill (Claude Code + Codex): extensive code reviews and advisory Q&A via Claude Fable 5 through the local `claude` CLI headless. Inverse of openai/codex-plugin-cc.

## Architecture

- `skill/` is the portable unit; `install.sh` symlinks it to `~/.claude/skills/fable-check` and `~/.codex/skills/fable-check`. Same SKILL.md for both agents.
- `skill/scripts/fable-check.mjs`: single zero-dep Node ESM script. Subcommands: `setup`, `review`, `ask` (advisory), `worker` (internal), `status`, `result`, `cancel`.
- Runs `claude -p --model claude-fable-5 --effort xhigh --output-format stream-json --verbose [--json-schema <schema>] --allowedTools <read-only set>`, prompt on **stdin**. Auth = user's Claude Code login, never an API key.
- **stream-json drives live progress**: `assistant` events' `tool_use` blocks → progress lines; final `{type:"result"}` event is the envelope (`result`, `structured_output`, `session_id`, `total_cost_usd`). Progress → stderr (foreground), job log, and throttled `progress` field in job JSON that `status` renders (stall warning after 5 min idle). Heartbeat ~20s; override `FABLE_CHECK_HEARTBEAT_MS` (inherited by background workers).
- `ask` reuses the job machinery: `prompts/advise.md`, no schema, kind `advisory`; `runJob` dispatches by `job.kind`.
- Job state/reports: `~/.fable-check/jobs/<repo-basename>-<sha1-8>/`, never inside reviewed repos.
- `--deep`: 3 `LENSES` concurrently, then merge pass at `high` effort via `prompts/merge.md`.

## Decisions

- **CLI flags verified against installed `claude`.** If one errors after a Claude Code update, re-run `claude --help` before changing code.
- Inline-diff threshold 400KB (Fable has 1M context); above it the reviewer self-collects via read-only git. Deliberately far above the original plugin's 256KB/2-file limit.
- `rescue` (task delegation) and the Stop-hook review gate deliberately excluded: out of scope; gate is plugin-only and drains usage.
- **`--json-schema` NOT reliably enforced on agentic `-p` runs** (CLI 2.1.170 returned freeform fenced JSON with renamed fields). Both mitigations required, don't remove either: (1) schema text appended verbatim to every prompt in `runClaude`; (2) `extractStructured` + `normalizeReviewData` tolerate fenced JSON, synonym field names, off-enum severities.
- Structured-output parse order: `envelope.structured_output` → fenced ```json → full-text `JSON.parse` → `{...}` regex. Envelope shape may change across CLI versions.
- Attribution: prompts/schema/target-selection adapted from codex-plugin-cc (Apache-2.0). Keep `NOTICE` if reused elsewhere.

## Common mistakes

- **Prompt to `claude` via stdin, not argv.** Large diffs exceed argv limits.
- **`--allowedTools` syntax is `Bash(git diff:*)`.** Bare `Bash(git:*)` is wrong.
- **Never widen the allowlist with write tools to "fix" denials.** `-p` mode can't answer permission prompts; auto-denial is what keeps the reviewer read-only.

## Testing

- **Offline (free):** `node --test test/*.test.mjs`. Covers extraction, normalization, argv, target selection (temp git repo), dead-worker reconciliation, CLI guards. Run after any change to parsing, prompts, or job state. Script exports pure functions, runs `main()` only when invoked directly; `FABLE_CHECK_STATE_DIR` redirects job state.
- **`--dry-run`** on `review`/`ask`: prints resolved target + assembled prompt, no claude call.
- **End-to-end (costs real usage):** temp git repo, seed a real bug, `node skill/scripts/fable-check.mjs review --effort low`, confirm the report finds it. Always `--effort low`.
