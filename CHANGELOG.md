# Changelog

## 2026-10-04 — cross-check: review by the other vendor's model

**TL;DR: fable-check became cross-check. Claude Code callers now get a Codex (gpt-6-astra) review, Codex callers get a Claude (Fable) review, and `--via both` runs both with an arbiter that lists where they disagree.**

- **Codex backend.** `codex exec --sandbox read-only --json --output-schema` with the same prompts, progress stream, job runner and report format as the Claude path.
- **Caller-aware routing.** `--via claude|codex|both`; without it, the script picks the caller's opposite (Astra from a plain terminal). Every report header names reviewer, model and effort.
- **Both mode.** Every pass runs on both models concurrently; the caller's opposite model arbitrates and the report opens with "Where they disagree". One side failing still yields the other's report with a note. Works for `review`, `--deep` and `ask`.
- **Effort.** Default is now `medium`; the skill prompt makes the agent offer low / medium / high. `max` stays Claude-only.
- **Fixes:** Claude Code's `--json-schema` now rejects the `$schema` key (stripped); OpenAI strict mode needs every property in `required` (schema updated); codex `turn.failed` messages now surface in the report.
- Renamed everything (`cross-check.mjs`, `~/.cross-check/jobs`, `CROSS_CHECK_*` env; the old `FABLE_CHECK_STATE_DIR` still works). Repo moved to github.com/jamieafk/cross-check (old URL redirects).


## 2026-07-17 — Trust fixes + free offline tests

**TL;DR: `result` can no longer hand you a stale report, dead background jobs recover cleanly, and the fragile parsing layer now has a free test suite.**

- **`result` refuses stale reports.** With no job id, `result` now errors while a job is still running instead of silently serving the *previous* run's report — the one way the tool could confidently return wrong information. Pass an id explicitly to fetch an old report. Every report is also stamped with its job id and creation time.
- **Dead background workers reconcile to `failed`.** A worker killed by sleep/reboot/`kill -9` used to leave its job "running" forever (`status` said dead, `result` said still running). Any read now persists it as failed with a clear report explaining what happened.
- **Offline test suite.** `node --test test/*.test.mjs` — 21 tests covering structured-output extraction, review normalization (synonym fields, off-enum severities), argv handling, review-target selection against a temp git repo, dead-worker reconciliation, and the CLI guards. No network, no claude calls, no cost.
- **`--dry-run` for `review` and `ask`.** Prints the resolved target and the fully assembled prompt without calling claude or creating a job — free verification of prompt/target changes.

## 2026-06-11 — Advisory mode + live progress

**TL;DR: fable-check can now answer questions, not just review code — and it's impossible to mistake a running job for a dead one.**

- **New `ask` command (advisory mode).** Ask Fable an architecture, design, or "is this plan sound?" question. It explores the repo with the same read-only tools and answers in prose, leading with one clear recommendation. No diff required.
- **Runs are never silent.** Every run streams live progress: a line per tool call (`tool #14: reading src/foo.js`), phase changes, and a heartbeat at least every ~20s with elapsed time and current activity (`FABLE_CHECK_HEARTBEAT_MS` to tune).
- **Live `status` for background jobs.** Shows elapsed time, phase, tool-call count, last activity and its age, plus an explicit healthy/possibly-stalled verdict. Stall detection keys off the model's actual events (including thinking ticks), so it only warns on real silence (5+ min).
- **Invoker guidance in SKILL.md.** Typical durations, "don't kill a run that's emitting heartbeats," and a recommended 30–60s `status` polling cadence — so agents like Codex no longer abandon long reviews as stalled.
- **Reliability hardening** (from an adversarial review of the change): atomic job-state writes (safe to poll), cancellation now actually terminates the underlying `claude` processes instead of orphaning them, and cancel/complete races can no longer resurrect or clobber a job's final state.

## 2026-06-10 — Initial public release

- `review` (standard / `--adversarial` / `--deep` three-lens), `setup`, background jobs with `status`/`result`/`cancel`.
- Read-only reviewer via the local `claude` CLI on the user's existing login; reports saved under `~/.fable-check/jobs/`.
- Apache-2.0, with prompt/schema design adapted from openai/codex-plugin-cc (see NOTICE).
