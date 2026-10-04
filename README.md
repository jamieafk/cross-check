# cross-check

Code review and advisory by the **other vendor's frontier model** — a skill for both **Claude Code** and **Codex**. Called from Claude Code it reviews with Codex (gpt-6-astra, "Astra"); called from Codex it reviews with Claude (Fable); `--via both` runs both and an arbiter lists where they disagree. The model that wrote the code never grades its own work.

Successor of fable-check; the two-way generalisation of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).

## What you get

- `review` — a thorough, structured review of your uncommitted changes or your branch vs a base. Verdict (approve / needs-attention), severity-sorted findings with file:line locations, confidence scores, and next steps.
- `review --adversarial [focus text]` — a skeptical review that actively tries to block the change. Steerable: "challenge the retry design", "look for race conditions", etc.
- `review --deep` — three parallel review passes (correctness, security & data safety, design & failure modes) merged and de-duplicated into one report. The most extensive mode.
- `review --via both` — both reviewers on the same change, merged by an arbiter into one report that opens with **Where they disagree**.
- `ask "<question>"` — advisory mode: the advisor explores your repo read-only and answers an architecture/design/tradeoff question in prose, with one clear recommendation. With `--via both` you get a recommendation plus where the two advisors agree and disagree.
- `status` / `result` / `cancel` + `--background` — run long jobs in the background with live progress (phase, elapsed time, tool activity).
- `setup` — checks both CLIs, their logins, and shows the detected routing.

## Routing

| Called from | Reviewer | Override |
|---|---|---|
| Claude Code | Astra (Codex, `gpt-6-astra`) | `--via claude` |
| Codex | Fable (Claude, `claude-fable-5`) | `--via codex` |
| plain terminal | Astra | `--via claude` |
| any | both + arbiter (the caller's opposite) | `--via both` |

Effort: `--effort low|medium|high|xhigh` (default `medium`; `max` is Claude-only). The skill prompt tells the invoking agent to offer low / medium / high before running.

The reviewer runs **read-only**: it can read files, grep, and run read-only git commands to verify findings against the real code, but it can never modify anything.

Runs are **never silent**: every tool call the reviewer makes streams to stderr as a progress line, with heartbeats every ~20s during thinking stretches — so a watching agent (or human) always knows it's alive, what phase it's in, and what it's doing.

## Requirements

- [Claude Code](https://claude.com/claude-code) and/or [Codex](https://github.com/openai/codex) installed and logged in (reviews use your existing subscriptions — no API keys). You need the CLI of whichever reviewer you route to; `both` needs both.
- Node.js 18+
- git

## Install

```bash
git clone https://github.com/jamieafk/cross-check.git
cd cross-check
./install.sh
```

This symlinks the skill into `~/.claude/skills/cross-check` and `~/.codex/skills/cross-check` and runs a setup check. After that:

- In **Claude Code** or **Codex**: say "cross-check my changes" / "get a second opinion on this".
- From a **terminal**, directly:

```bash
node skill/scripts/cross-check.mjs review
node skill/scripts/cross-check.mjs review --base main
node skill/scripts/cross-check.mjs review --adversarial question whether this caching design is safe
node skill/scripts/cross-check.mjs review --deep --background
node skill/scripts/cross-check.mjs review --via both --effort high
node skill/scripts/cross-check.mjs ask "is the detached-worker design for background jobs sound, or should this use a queue?"
node skill/scripts/cross-check.mjs status   # live progress of a background job
node skill/scripts/cross-check.mjs result
```

## How it works

The script collects your git context (working-tree diff or branch diff against a base). Small diffs are inlined into the prompt; large ones switch the reviewer into self-collect mode, where it explores the repo itself with read-only tools. It then runs the chosen CLI headlessly, prompt on stdin:

```
claude -p --model claude-fable-5 --effort <e> --output-format stream-json --json-schema <schema> --allowedTools <read-only set>
codex exec --sandbox read-only --json --output-schema <schema> --model gpt-6-astra -c model_reasoning_effort=<e> -
```

Both event streams drive the same live progress reporting (per-tool-call lines + heartbeats on stderr; live `status` for background jobs); the final message carries the structured review, validated against the schema. In `both` mode every pass runs on both models concurrently and an arbiter pass on the caller's opposite model merges them, recording disagreements. Reports are printed, saved under `~/.cross-check/jobs/<repo>/`, stamped with reviewer/model/effort, and include a resume command per reviewer.

## Differences from codex-plugin-cc

| | codex-plugin-cc | cross-check |
|---|---|---|
| Reviewer model | GPT-5.x via Codex | the other vendor's: Astra from Claude Code, Fable from Codex, or both |
| Host | Claude Code (plugin) | Claude Code **and** Codex (skill), or plain terminal |
| Reviewer capabilities | inline diff or self-collect | same, plus agentic read-only repo exploration in every mode |
| Deep mode | — | `--deep`: 3 parallel lenses per reviewer + merge pass |
| Two-model arbitration | — | `--via both`: disagreement summary |
| Task delegation (`rescue`) | yes | not included (out of scope: this is a review tool) |
| Stop-hook review gate | optional | not included (plugin-only machinery; drains usage) |

## License & attribution

Apache-2.0 — see `LICENSE`.

This project is **inspired by, and adapts portions of,** [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0): the review/adversarial prompt structure, the structured findings schema, and the review-target selection design. See `NOTICE` for details. All other code is original.

cross-check is an independent project, **not affiliated with or endorsed by OpenAI or Anthropic**. "Claude" and "Codex" refer to the third-party tools it integrates with.
