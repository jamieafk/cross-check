# QoL Fixes: result guard, dead-worker reconcile, offline tests Implementation Plan

**Goal:** Close two trust gaps in the job runner (stale `result` output, stuck dead-worker jobs) and add free offline regression tests + `--dry-run` for the fragile parsing/prompt layer.

**Architecture:** All runtime changes stay inside `skill/scripts/fable-check.mjs` (single-file design is deliberate). Tests live outside the portable skill folder at `test/fable-check.test.mjs` using `node --test` — the script gains a direct-run guard and named exports so it can be imported without executing the CLI.

**Tech Stack:** Node built-in test runner (`node --test`), no new dependencies.

---

### Task 1: Stamp reports with job identity (finding 3, part A)

**Files:** Modify `skill/scripts/fable-check.mjs`

- [ ] Pass `job` into `executeReview`/`executeAdvisory` via `runJob`; set `meta.jobId` and `meta.createdAt`.
- [ ] `renderReport`/`renderFailure` add a `Job: <id> | created <ISO time>` line under `Target:`.

### Task 2: `result` refuses stale reports (finding 3, part B)

**Files:** Modify `skill/scripts/fable-check.mjs`

- [ ] In `handleResult` with no job id: if any job is running/queued (after dead-worker reconcile), fail with the running job's id + age and the latest finished job id, telling the caller to pass an id explicitly for the old report.

### Task 3: Persist dead-worker jobs as failed (finding 4)

**Files:** Modify `skill/scripts/fable-check.mjs`

- [ ] Add `reconcileDeadJob(dir, job)`: status running/queued + pid set + pid dead → persist `failed` with `error: "worker process died"`, `completedAt`, `pid: null`, and write a failure report file if none exists.
- [ ] Call it from `listJobs` and the single-job reads in `status` / `result` / `cancel`. Never reconcile a job owned by the current process.

### Task 4: `--dry-run` flag (finding 5, part A)

**Files:** Modify `skill/scripts/fable-check.mjs`

- [ ] `review --dry-run`: resolve target, collect context, build the (non-lens) prompt; print target summary + assembled prompt to stdout. No claude call, no job created, no claude-CLI requirement.
- [ ] `ask --dry-run`: same for the advise prompt.

### Task 5: Importable module + offline tests (finding 5, part B)

**Files:** Modify `skill/scripts/fable-check.mjs`; Create `test/fable-check.test.mjs`

- [ ] Guard `main()` behind a realpath comparison of `process.argv[1]` vs `import.meta.url`; export the pure functions (parsing, normalizing, target selection, reconcile).
- [ ] `STATE_ROOT` honors `FABLE_CHECK_STATE_DIR` so tests don't touch `~/.fable-check`.
- [ ] Tests: `extractStructured` (structured_output, fenced JSON, prose-wrapped, garbage), `normalizeReviewData` (severity aliases, bad category, `lines: "10-20"`, confidence clamp, verdict synonyms), argv handling, `resolveReviewTarget` against a temp git repo (dirty → working-tree, clean → branch), dead-worker reconcile against a temp state dir.

### Task 6: Docs

**Files:** Modify `skill/scripts/fable-check.mjs` (usage text), `CLAUDE.md`, `CHANGELOG.md`

- [ ] Usage text mentions `--dry-run`.
- [ ] CLAUDE.md Testing section: offline tests first (`node --test test/`), paid e2e second.
- [ ] CHANGELOG entry.
