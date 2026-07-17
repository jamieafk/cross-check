# fable-check — project context

Cross-agent skill (Claude Code + Codex) that runs extensive code reviews and advisory Q&A using Claude Fable 5 via the local `claude` CLI in headless mode. Inverse of openai/codex-plugin-cc.

## Architecture

- `skill/` is the portable unit — symlinked into `~/.claude/skills/fable-check` and `~/.codex/skills/fable-check` by `install.sh`. Both agents read the same SKILL.md format.
- `skill/scripts/fable-check.mjs` — single zero-dependency Node ESM script. Subcommands: `setup`, `review`, `ask` (advisory), `worker` (internal), `status`, `result`, `cancel`.
- Runs call `claude -p --model claude-fable-5 --effort xhigh --output-format stream-json --verbose [--json-schema <schema>] --allowedTools <read-only set>` with the prompt on **stdin**. Auth is the user's Claude Code login — never an API key.
- **stream-json powers live progress**: each `assistant` event's `tool_use` blocks become progress lines; the final `{type:"result"}` event is the envelope (same fields as `--output-format json`: `result`, `structured_output`, `session_id`, `total_cost_usd` — verified empirically 2026-06-11). Progress goes to stderr (foreground), the job log, and a throttled `progress` field in the job JSON that `status` renders (elapsed/phase/tool calls/last activity + stall warning after 5 min idle). Heartbeat every ~20s (override: `FABLE_CHECK_HEARTBEAT_MS`, inherited by background workers).
- `ask` reuses the same job machinery with `prompts/advise.md`, no schema (prose answer from `envelope.result`), kind `advisory`; `runJob` dispatches executor by `job.kind`.
- Job state and reports live in `~/.fable-check/jobs/<repo-basename>-<sha1-8>/` — never inside reviewed repos.
- `--deep` runs the 3 lenses in `LENSES` concurrently, then a merge pass at `high` effort using `prompts/merge.md`.

## Decisions

- **CLI flags were verified against the installed `claude` binary** (`--json-schema`, `--effort`, `--allowedTools`, `--output-format stream-json` + `--verbose` all exist). If a flag errors after a Claude Code update, re-run `claude --help` before changing code.
- Inline-diff threshold is 400KB (Fable has 1M context); above that the reviewer self-collects via read-only git commands. This is deliberately much more generous than the original plugin's 256KB/2-file limit.
- `rescue` (task delegation) and the Stop-hook review gate from the original plugin were deliberately excluded — out of scope for a review skill; the gate is plugin-only and drains usage.
- **`--json-schema` is NOT reliably enforced on agentic `-p` runs** (verified empirically on CLI 2.1.170: a simple prompt returns `structured_output`; a tool-using review returned freeform fenced JSON with renamed fields like `status`/`lines`/`fix`). Mitigations, both required: (1) the schema text is appended to every prompt verbatim in `runClaude`; (2) `extractStructured` + `normalizeReviewData` tolerate fenced JSON, synonym field names, and off-enum severities. Don't remove either.
- Structured-output parsing order: `envelope.structured_output` → fenced ```json block → full-text `JSON.parse` → `{...}` regex extract. Don't assume the envelope shape is stable across CLI versions.
- Attribution: prompts/schema/target-selection adapted from codex-plugin-cc (Apache-2.0). Keep `NOTICE` if those parts are reused elsewhere.

## Common mistakes

- The prompt must go to `claude` via **stdin**, not argv — large diffs exceed argv limits.
- `--allowedTools` patterns use the `Bash(git diff:*)` prefix syntax; bare `Bash(git:*)` is wrong.
- In `-p` (print) mode, tool permission prompts can't be answered — anything not in the allowlist is auto-denied, which is what makes the reviewer read-only. Don't "fix" denials by widening the allowlist with write tools.

## Testing

- **Offline first (free):** `node --test test/*.test.mjs` — covers structured-output extraction, review normalization, argv handling, target selection (temp git repo), dead-worker reconciliation, and CLI guards. Run after any change to parsing, prompts, or job state. The script exports its pure functions and only runs `main()` when invoked directly; `FABLE_CHECK_STATE_DIR` redirects job state for tests.
- **`--dry-run`** on `review`/`ask` prints the resolved target + assembled prompt without calling claude — free way to eyeball prompt changes.
- **End-to-end (costs real Fable 5 usage):** create a temp git repo, seed a real bug in a diff, run `node skill/scripts/fable-check.mjs review --effort low`, confirm a structured report finds the bug. Use `--effort low`.
