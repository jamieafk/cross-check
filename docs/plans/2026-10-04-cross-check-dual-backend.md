# cross-check: dual-backend revamp

**Goal:** One skill that reviews with the *other* vendor's model: Claude callers get Codex (gpt-6-astra), Codex callers get Claude (Fable), plus a `both` mode with a disagreement summary.

**Architecture:** The script keeps its prompts → run → extract → render → job pipeline. `runClaude` becomes one of two backends behind `runModel({ backend })`; routing (`--via`, env detection) picks the backend; `both` runs each backend concurrently and merges on the caller's opposite model.

**Tech:** Node ESM, zero deps. `claude -p --output-format stream-json` and `codex exec --json --output-schema -s read-only`.

### Task 1: Rename
- [ ] `git mv` script/test; `fable-check`→`cross-check`, `FABLE_CHECK_*`→`CROSS_CHECK_*` (old state-dir env kept as fallback); state at `~/.cross-check/jobs`.
- [ ] install.sh symlinks `cross-check`; remove stale `fable-check` symlink in `~/.codex/skills`.

### Task 2: Backend layer
- [ ] `BACKENDS` map (claude: Fable; codex: Astra) with `run`, `ensure`, `defaultModel`, `efforts`, `resumeHint`.
- [ ] `runCodex`: `codex exec -s read-only --json --skip-git-repo-check -m <model> -c model_reasoning_effort=<e> [--output-schema] -`; prompt on stdin; `command_execution` events → tool progress; last `agent_message` → envelope.result; `thread.started` → session id. Effort `max` maps to `xhigh`.
- [ ] `resolveVia(flag, env)`: flag wins; else `CLAUDECODE`→codex, `CODEX_SESSION_ID`→claude, else codex.
- [ ] Effort validated against the chosen backend(s); default `medium`.

### Task 3: Both mode
- [ ] review: run passes on both backends (×3 lenses in deep), merge with `prompts/merge-both.md`; JSON gains `disagreements[]`; report prints "Where they disagree" first.
- [ ] ask: both answers, then a merge pass (`prompts/advise-merge.md`) with agree/disagree/recommendation.
- [ ] One side failing → other side's report plus a note.

### Task 4: Setup, docs, tests
- [ ] `setup` checks both CLIs and logins. Report header stamps reviewer/model/effort.
- [ ] SKILL.md (offer low/medium/high), README, AGENTS.md, CHANGELOG, SHARED.md line.
- [ ] Offline tests: routing, effort validation, codex event reducer (fixture), merge labeling. E2E at low effort on both backends.
