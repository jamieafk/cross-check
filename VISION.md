# Vision — cross-check

## Product goal

Give any coding agent (Claude Code, Codex) and any terminal a one-command, extensive code review — or advisory answer to an architecture/design question — by the *other* vendor's frontier model, so the model that wrote the code never grades its own work. Optionally both models with an arbiter that names their disagreements.

## Target user

Builders who do most of their development through coding agents and want an independent, high-quality second opinion on changes without leaving their workflow or setting up API keys.

## Success criteria

- One command produces a review a senior engineer would respect: real findings with file:line evidence, no style noise, honest "approve" when the change is sound.
- Works identically from Claude Code and Codex, and automatically picks the opposite vendor.
- Zero configuration beyond existing Claude Code / Codex logins.
- Reviews are provably read-only.

## Constraints

- No API key flows — subscription auth via the local `claude` / `codex` CLIs only.
- Zero npm dependencies in the skill (must run anywhere Node 18+ exists).
- Findings must be schema-validated; a malformed model response surfaces as an explicit failure, never a fabricated report.

## Non-goals (for now)

- Fixing the issues it finds (the host agent can do that as a follow-up).
- Task delegation to Claude ("rescue"-style) — separate product.
- Stop-hook review gates.
- PR/GitHub integration (inline comments, CI) — possible later.
