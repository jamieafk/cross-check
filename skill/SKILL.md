---
name: cross-check
description: Get a code review or advisory answer from the *other* vendor's frontier model. From Claude Code it reviews with Codex (gpt-6-astra, "Astra"); from Codex it reviews with Claude (Fable); `both` runs the two and an arbiter lists where they disagree. Use when the user asks for a cross-check, a second opinion, a code review, a pre-ship / adversarial / deep review of the working tree or a branch, or wants independent advice on an architecture choice, design tradeoff, plan, or technical decision. Read-only — it never modifies code.
---

# cross-check — review by the other model

Runs a structured, read-only code review or advisory question through a frontier model from the *other* vendor, so the model that wrote the code never grades its own work. The reviewer gets read-only tools (file reads, grep, read-only git), so it verifies claims against the real code instead of guessing.

All commands run from the repository being reviewed. `<skill-dir>` is this skill's directory (the folder containing this SKILL.md).

## Core constraint

- This skill is **read-only**. Never fix issues, apply patches, or imply you are about to make changes as part of running it.
- Return the script's output to the user **verbatim** — do not paraphrase, summarize, or filter the findings or the answer.
- After presenting the output, you may offer to act on it as a separate follow-up.

## Before running: pick the effort

Ask the user which effort to use unless they already said: **low** (fast, cheapest; fine for small diffs), **medium** (default; solid everyday review), **high** (thorough; pre-ship or anything subtle). Offer exactly those three. `xhigh` exists for when the user asks for the most extensive review possible; `max` is Claude-only. Pass the choice as `--effort <level>`.

Also mention which model will review (see Routing) so the user can override with `--via`.

## Routing

The script picks the reviewer automatically: inside Claude Code → **Astra** (Codex); inside Codex → **Fable** (Claude); plain terminal → Astra. Override with `--via claude`, `--via codex`, or `--via both`.

`--via both` runs both reviewers on the same change concurrently, then an arbiter (the caller's opposite model) merges them into one report whose first section is **Where they disagree**. Use it when the stakes justify two opinions; it costs both usage budgets.

## Commands

Standard review of current work (auto-detects: dirty tree → working-tree diff; clean tree → branch vs default branch):

```bash
node "<skill-dir>/scripts/cross-check.mjs" review --effort medium
```

Review a branch against a base:

```bash
node "<skill-dir>/scripts/cross-check.mjs" review --base main
```

Adversarial review (skeptical, tries to block the change; accepts steering text):

```bash
node "<skill-dir>/scripts/cross-check.mjs" review --adversarial challenge the caching and retry design
```

Deep review (three parallel lens passes — correctness, security/data-safety, design/failure-modes — merged into one report; the most extensive and most expensive mode):

```bash
node "<skill-dir>/scripts/cross-check.mjs" review --deep
```

Both reviewers with a disagreement summary:

```bash
node "<skill-dir>/scripts/cross-check.mjs" review --via both
```

Advisory — ask a question instead of requesting a review (architecture choices, design tradeoffs, "is this plan sound?", second opinions). The advisor explores the repo read-only and answers in prose with one clear recommendation. With `--via both`, the arbiter returns a recommendation plus where the two advisors agree and disagree:

```bash
node "<skill-dir>/scripts/cross-check.mjs" ask "should the job runner move to worker threads, or is the detached-process design right?"
```

Other flags (both `review` and `ask`): `--via claude|codex|both`, `--effort low|medium|high|xhigh` (default `medium`), `--model <model>` (overrides the single selected backend's model; not allowed with `both`), `--background`, `--json`, `--quiet`, `--dry-run` (prints routing, target and prompt; calls no model). `review` also takes `--scope auto|working-tree|branch` and `--base <ref>`.

## Progress reporting — IMPORTANT for invoking agents

Runs take minutes, but they are **never silent**. The script streams progress to **stderr** (stdout stays clean for the final report):

- a routing line (`via codex → Astra | effort medium`) and a startup banner with the target,
- a line for every tool call the reviewer makes (`tool #14: running: git diff ...`), tagged by reviewer in `both` mode,
- phase changes (`phase: passes: 2/6 complete`, `phase: merging ... (arbiter: Astra)`),
- a heartbeat at least every ~20 seconds during thinking stretches.

Interpretation rules:

- **Do not kill or abandon a run that is emitting progress lines or heartbeats — it is healthy.** Typical durations: standard review 2–8 min, deep review 5–15 min, advisory 1–6 min, `both` roughly the longer of the two plus a merge pass.
- Silence for more than ~60 seconds is abnormal; only then check on it. `status` flags a job as `possibly stalled` after 5 minutes without model events.
- If your execution harness has a command timeout shorter than ~15 minutes, run with `--background` instead of stretching the timeout.

## Foreground vs background

- Small change (1–3 files) or a quick advisory question → foreground; relay the streamed progress if your harness shows it.
- Anything larger, `--deep`, or `--via both` → background.

Background options (either works):

1. Use your own background-execution facility to run the foreground command, then report results when it completes.
2. Or use the built-in job runner:

```bash
node "<skill-dir>/scripts/cross-check.mjs" review --background     # or: ask --background "..."
node "<skill-dir>/scripts/cross-check.mjs" status                  # live progress: phase, elapsed, tool calls, last activity
node "<skill-dir>/scripts/cross-check.mjs" result                  # final report (latest job)
node "<skill-dir>/scripts/cross-check.mjs" cancel                  # stop an active job
```

`status` on a running job shows elapsed time, current phase, tool-call count, the last activity with its age, and a healthy/possibly-stalled verdict — poll it every 30–60 seconds. When you launch a background job, tell the user the job id and that they can ask for status/results at any time.

## Setup / troubleshooting

If a run fails because a CLI is missing or logged out:

```bash
node "<skill-dir>/scripts/cross-check.mjs" setup
```

It checks both `claude` and `codex`, their logins, and reports the detected routing with the exact next step. Runs use the user's existing subscriptions — no API keys.

## Notes

- For reviews there must be something to review: uncommitted changes, or commits ahead of the base branch. If the script reports nothing to review, relay that — do not invent a review. (`ask` has no such requirement.)
- Every report header names the reviewer(s), model and effort. Reports are saved under `~/.cross-check/jobs/<repo>/` and include a resume command per reviewer (`claude -r <id>` / `codex exec resume <id>`).
- Focus text is most effective with `--adversarial`; the standard review takes no steering so its judgment stays neutral. For steered questions, prefer `ask`.
