# cross-check — project context

Cross-agent skill (Claude Code + Codex): code review and advisory Q&A by the *other* vendor's model. Claude callers get Codex (gpt-6-astra, "Astra"); Codex callers get Claude (Fable); `--via both` runs both and an arbiter merges them. Successor of fable-check; inverse of openai/codex-plugin-cc.

## Architecture

- `skill/` is the portable unit; `install.sh` symlinks it to `~/.claude/skills/cross-check` and `~/.codex/skills/cross-check`. Same SKILL.md for both agents.
- `skill/scripts/cross-check.mjs`: single zero-dep Node ESM script. Subcommands: `setup`, `review`, `ask`, `worker` (internal), `status`, `result`, `cancel`.
- **Backends** (`BACKENDS` map): `claude` → `claude -p --output-format stream-json --json-schema ...`; `codex` → `codex exec --sandbox read-only --json --output-schema <file> -c model_reasoning_effort=...`. Both take the prompt on **stdin** and resolve to the same envelope shape (`result`, `session_id`, …) via the shared `runCli` plumbing. Auth = the user's existing logins, never API keys.
- **Routing** (`resolveVia`): `--via` wins; else `CLAUDECODE` env → codex, `CODEX_SESSION_ID`/`CODEX_THREAD_ID` → claude, neither → codex. `both` = every pass on both backends concurrently, then a merge on `mergerFor()` = the caller's opposite, with `prompts/merge-both.md` / `advise-merge.md` and a `disagreements[]` field rendered first.
- Live progress: claude `assistant.tool_use` events and codex `item.started command_execution` events → progress lines → stderr, job log, throttled `progress` in job JSON (stall warning after 5 min idle). Heartbeat ~20s; `CROSS_CHECK_HEARTBEAT_MS` overrides.
- Job state/reports: `~/.cross-check/jobs/<repo-basename>-<sha1-8>/`, never inside reviewed repos. `CROSS_CHECK_STATE_DIR` redirects (tests).
- `--deep`: 3 `LENSES` per backend concurrently, then merge at `high` effort.

## Decisions

- **Default effort `medium`; SKILL.md makes the agent offer low/medium/high.** `max` is Claude-only, so `validateEffort` takes the intersection across the backends that will run.
- **Prompts name the reviewer via `{{REVIEWER}}`**, never a hardcoded vendor. `interpolate()` blanks unknown keys, so every prompt build must pass REVIEWER (advisory builds per backend).
- **Schema flags are belt-and-braces on both CLIs**: schema text is appended to every prompt AND passed as a flag, and `extractStructured`/`normalizeReviewData` tolerate fenced JSON, synonym fields, off-enum severities. Keep both.
- **OpenAI strict schema rules**: every property must be listed in `required` and every object needs `additionalProperties:false`, or codex fails the turn with `invalid_json_schema`. That is why `disagreements` is required (empty array in single-reviewer runs).
- **Claude's `--json-schema` rejects the `$schema` key**; `runClaude` strips it before passing the flag.
- Inline-diff threshold 400KB; above it the reviewer self-collects via read-only git.
- `rescue` (task delegation) and Stop-hook gates deliberately excluded.
- Attribution: prompts/schema/target-selection adapted from codex-plugin-cc (Apache-2.0). Keep `NOTICE`.

## Common mistakes

- **Prompt via stdin, not argv** (codex: trailing `-`). Large diffs exceed argv limits.
- **`--allowedTools` syntax is `Bash(git diff:*)`**; never widen it with write tools to "fix" denials — auto-denial is what keeps the claude reviewer read-only. The codex side relies on `--sandbox read-only`.
- **codex can exit 0 after `turn.failed`**; `runCodex` folds the `error`/`turn.failed` message into stderr and forces a non-zero status so the report shows the reason.
- **`--model` with `--via both` is rejected** (ambiguous); use a single `--via`.

## Testing

- **Offline (free):** `node --test test/*.test.mjs` — routing, effort validation, codex event reduction (recorded fixtures), extraction/normalization, target selection, dead-worker reconciliation, dry runs. Run after any change to parsing, prompts, routing, or job state.
- **`--dry-run`** on `review`/`ask`: prints routing + target + assembled prompt, no model call.
- **End-to-end (costs real usage):** temp git repo, seed a real bug, run `review --effort low` with `--via codex`, `--via claude`, and `--via both`; confirm each finds it and the both-report has a "Where they disagree" section. Always `--effort low`.
