// Offline regression tests for cross-check's fragile layers: structured-output
// parsing, review normalization, arg handling, target selection, and job-state
// reconciliation. No network, no claude CLI, no cost — run with `node --test test/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Point job state at a throwaway dir BEFORE importing the module under test.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cross-check-test-state-"));
process.env.CROSS_CHECK_STATE_DIR = STATE_DIR;

const SCRIPT = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "skill",
  "scripts",
  "cross-check.mjs"
);
const {
  BACKENDS,
  detectCaller,
  resolveVia,
  backendsFor,
  mergerFor,
  reviewerLabel,
  codexEventReducer,
  codexEffort,
  splitRawArgumentString,
  normalizeArgv,
  parseArgs,
  extractStructured,
  normalizeReviewData,
  resolveReviewTarget,
  collectReviewContext,
  jobStampLine,
  renderReport,
  jobsDir,
  writeJob,
  readJob,
  listJobs,
  reconcileDeadJob,
} = await import(SCRIPT);

function makeTempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cross-check-test-repo-"));
  const run = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  run("init", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
  run("add", "a.txt");
  run("commit", "-m", "initial");
  return { repo, run };
}

// A pid that is guaranteed dead: spawn a no-op and wait for it to exit.
function deadPid() {
  const result = spawnSync("sh", ["-c", "exit 0"]);
  return result.pid;
}

// ---------------------------------------------------------------------------
// extractStructured — envelope shapes seen in the wild (CLI 2.1.170)

test("extractStructured prefers structured_output when present", () => {
  const data = { verdict: "approve", findings: [] };
  assert.deepEqual(extractStructured({ structured_output: data, result: "ignored" }), data);
});

test("extractStructured parses fenced JSON with renamed fields", () => {
  const envelope = {
    result:
      'Here is my review:\n```json\n{"status": "needs work", "findings": [{"title": "Bug", "lines": "10-20", "fix": "do X"}]}\n```\nDone.',
  };
  const parsed = extractStructured(envelope);
  assert.equal(parsed.status, "needs work");
  assert.equal(parsed.findings[0].lines, "10-20");
});

test("extractStructured parses bare JSON text", () => {
  assert.deepEqual(extractStructured({ result: '{"verdict": "approve"}' }), {
    verdict: "approve",
  });
});

test("extractStructured extracts a brace block from surrounding prose", () => {
  const parsed = extractStructured({
    result: 'The review found nothing. {"verdict": "approve", "findings": []} End.',
  });
  assert.equal(parsed.verdict, "approve");
});

test("extractStructured returns null for prose and missing envelopes", () => {
  assert.equal(extractStructured({ result: "All good, ship it." }), null);
  assert.equal(extractStructured(null), null);
  assert.equal(extractStructured({ result: "[1, 2, 3]" }), null);
});

// ---------------------------------------------------------------------------
// normalizeReviewData — synonym fields, off-enum values, loose line refs

test("normalizeReviewData maps severity aliases and clamps unknowns to low", () => {
  const data = normalizeReviewData({
    findings: [
      { severity: "Blocker" },
      { severity: "major" },
      { severity: "info" },
      { severity: "catastrophic" },
    ],
  });
  assert.deepEqual(
    data.findings.map((f) => f.severity),
    ["critical", "high", "low", "low"]
  );
});

test("normalizeReviewData accepts synonym field names", () => {
  const data = normalizeReviewData({
    status: "needs work",
    findings: [
      {
        title: "Bug",
        details: "explanation",
        path: "src/x.js",
        lines: "10-20",
        fix: "do X",
        category: "nonsense",
      },
    ],
  });
  const f = data.findings[0];
  assert.equal(data.verdict, "needs-attention");
  assert.equal(f.body, "explanation");
  assert.equal(f.file, "src/x.js");
  assert.equal(f.line_start, 10);
  assert.equal(f.line_end, 20);
  assert.equal(f.recommendation, "do X");
  assert.equal(f.category, "other");
});

test("normalizeReviewData maps approve-like verdicts and clamps confidence", () => {
  const data = normalizeReviewData({
    verdict: "APPROVED",
    findings: [{ confidence: 3 }, { confidence: -1 }, {}],
  });
  assert.equal(data.verdict, "approve");
  assert.deepEqual(
    data.findings.map((f) => f.confidence),
    [1, 0, 0.5]
  );
});

test("normalizeReviewData survives junk findings", () => {
  const data = normalizeReviewData({ findings: [null, "text", 42] });
  assert.equal(data.findings.length, 3);
  for (const f of data.findings) {
    assert.equal(f.severity, "low");
    assert.equal(f.file, "unknown");
  }
});

// ---------------------------------------------------------------------------
// argv handling

test("splitRawArgumentString splits shell-style quoted strings", () => {
  assert.deepEqual(splitRawArgumentString('review --base main "focus on retries"'), [
    "review",
    "--base",
    "main",
    "focus on retries",
  ]);
});

test("normalizeArgv splits a single space-containing argument", () => {
  assert.deepEqual(normalizeArgv(["review --deep"]), ["review", "--deep"]);
  assert.deepEqual(normalizeArgv(["review", "--deep"]), ["review", "--deep"]);
});

test("parseArgs handles value flags, = form, bool flags, and positionals", () => {
  const { options, positionals } = parseArgs(
    ["--base", "main", "--effort=low", "--deep", "focus", "text"],
    { valueFlags: ["base", "effort"], boolFlags: ["deep"] }
  );
  assert.equal(options.base, "main");
  assert.equal(options.effort, "low");
  assert.equal(options.deep, true);
  assert.deepEqual(positionals, ["focus", "text"]);
});

// ---------------------------------------------------------------------------
// review target selection (temp git repo, no claude involved)

test("resolveReviewTarget picks working-tree when dirty, branch when clean", () => {
  const { repo } = makeTempRepo();
  assert.equal(resolveReviewTarget(repo, {}).mode, "branch");
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  assert.equal(resolveReviewTarget(repo, {}).mode, "working-tree");
  assert.equal(resolveReviewTarget(repo, { scope: "working-tree" }).mode, "working-tree");
  const based = resolveReviewTarget(repo, { base: "main" });
  assert.equal(based.mode, "branch");
  assert.equal(based.baseRef, "main");
});

test("collectReviewContext inlines small diffs and untracked files", () => {
  const { repo } = makeTempRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "brand new\n");
  const context = collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" });
  assert.equal(context.inline, true);
  assert.match(context.content, /changed/);
  assert.match(context.content, /brand new/);
  assert.equal(context.fileCount, 2);
});

// ---------------------------------------------------------------------------
// report stamping

test("renderReport stamps the job id and creation time", () => {
  const rendered = renderReport(
    { verdict: "approve", summary: "Fine.", findings: [], next_steps: [] },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      jobId: "rev-abc123",
      createdAt: "2026-07-17T00:00:00.000Z",
    }
  );
  assert.match(rendered, /Job: rev-abc123 \| created 2026-07-17T00:00:00\.000Z/);
  assert.equal(jobStampLine({}), null);
});

// ---------------------------------------------------------------------------
// dead-worker reconciliation (temp state dir via CROSS_CHECK_STATE_DIR)

function seedJob(dir, overrides) {
  const id = overrides.id;
  const job = {
    id,
    kind: "review",
    status: "running",
    title: "Fable review",
    targetLabel: "working tree diff",
    createdAt: new Date().toISOString(),
    completedAt: null,
    pid: null,
    reportFile: path.join(dir, `${id}.md`),
    logFile: path.join(dir, `${id}.log`),
    request: {},
    ...overrides,
  };
  writeJob(dir, job);
  return job;
}

test("reconcileDeadJob marks a dead-worker job failed and writes a report", () => {
  const dir = jobsDir(fs.mkdtempSync(path.join(os.tmpdir(), "cross-check-test-r1-")));
  seedJob(dir, { id: "rev-dead0001", status: "running", pid: deadPid() });
  const reconciled = reconcileDeadJob(dir, readJob(dir, "rev-dead0001"));
  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.error, "worker process died");
  assert.equal(reconciled.pid, null);
  assert.equal(readJob(dir, "rev-dead0001").status, "failed");
  assert.match(fs.readFileSync(reconciled.reportFile, "utf8"), /worker process died/);
});

test("reconcileDeadJob leaves live, own-process, and finished jobs alone", () => {
  const dir = jobsDir(fs.mkdtempSync(path.join(os.tmpdir(), "cross-check-test-r2-")));
  seedJob(dir, { id: "rev-own00001", status: "running", pid: process.pid });
  seedJob(dir, { id: "rev-done0001", status: "completed", pid: null });
  assert.equal(reconcileDeadJob(dir, readJob(dir, "rev-own00001")).status, "running");
  assert.equal(reconcileDeadJob(dir, readJob(dir, "rev-done0001")).status, "completed");
});

test("reconcileDeadJob never clobbers an outcome written after our stale read", () => {
  const dir = jobsDir(fs.mkdtempSync(path.join(os.tmpdir(), "cross-check-test-r4-")));
  // On disk the worker already finished; our in-memory copy is a stale
  // "running" read with a now-dead pid.
  seedJob(dir, { id: "rev-race0001", status: "completed", pid: null, verdict: "approve" });
  const stale = { ...readJob(dir, "rev-race0001"), status: "running", pid: deadPid() };
  const reconciled = reconcileDeadJob(dir, stale);
  assert.equal(reconciled.status, "completed");
  assert.equal(readJob(dir, "rev-race0001").status, "completed");
});

test("listJobs reconciles dead workers as a side effect", () => {
  const dir = jobsDir(fs.mkdtempSync(path.join(os.tmpdir(), "cross-check-test-r3-")));
  seedJob(dir, { id: "rev-dead0002", status: "running", pid: deadPid() });
  const jobs = listJobs(dir);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "failed");
});

// ---------------------------------------------------------------------------
// CLI integration (spawns the script; still offline and free)

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("result without an id refuses while a job is running", async () => {
  const { repo } = makeTempRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-check-test-cli-"));
  const env = { CROSS_CHECK_STATE_DIR: stateDir };
  // The CLI keys job dirs on <basename>-<sha1(repoRoot) first 8>; repoRoot
  // comes from `git rev-parse --show-toplevel`, which resolves symlinks.
  const realRepo = fs.realpathSync(repo);
  const slug = `${path.basename(realRepo)}-${crypto.createHash("sha1").update(realRepo).digest("hex").slice(0, 8)}`;
  const cliJobsDir = path.join(stateDir, slug);
  fs.mkdirSync(cliJobsDir, { recursive: true });

  // Seed a live "running" job and an older finished one in the CLI's state dir.
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    seedJobIn(cliJobsDir, { id: "rev-old00001", status: "completed", pid: null });
    seedJobIn(cliJobsDir, { id: "rev-live0001", status: "running", pid: sleeper.pid });

    const blocked = runCli(["result"], { cwd: repo, env });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /rev-live0001 is still running/);
    assert.match(blocked.stderr, /rev-old00001/);

    // Explicit id still serves the old report.
    const explicit = runCli(["result", "rev-old00001"], { cwd: repo, env });
    assert.equal(explicit.status, 0, explicit.stderr);
  } finally {
    sleeper.kill("SIGKILL");
  }
});

function seedJobIn(dir, overrides) {
  const id = overrides.id;
  const job = {
    id,
    kind: "review",
    status: "running",
    title: "Fable review",
    targetLabel: "working tree diff",
    createdAt:
      overrides.id === "rev-old00001"
        ? new Date(Date.now() - 60_000).toISOString()
        : new Date().toISOString(),
    completedAt: null,
    pid: null,
    reportFile: path.join(dir, `${id}.md`),
    logFile: path.join(dir, `${id}.log`),
    request: {},
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(job, null, 2));
  if (job.status === "completed") {
    fs.writeFileSync(job.reportFile, `# Fable Review\n\nJob: ${id}\n\nNo material findings.\n`);
  }
  return job;
}

test("review --dry-run prints the assembled prompt without calling claude", () => {
  const { repo } = makeTempRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  const result = runCli(["review", "--dry-run"], {
    cwd: repo,
    env: { CROSS_CHECK_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "cross-check-test-dr-")) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry run \(no model call, no job created\)/);
  assert.match(result.stdout, /working tree diff/);
  assert.match(result.stdout, /assembled prompt below/);
  assert.match(result.stdout, /changed/); // the diff made it into the prompt
});

test("ask --dry-run prints the assembled advisory prompt", () => {
  const { repo } = makeTempRepo();
  const result = runCli(["ask", "--dry-run", "is the design sound?"], {
    cwd: repo,
    env: { CROSS_CHECK_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "cross-check-test-da-")) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /is the design sound\?/);
  assert.match(result.stdout, /assembled prompt below/);
});

// ---------------------------------------------------------------------------
// routing: who reviews whom

test("routing: Claude caller gets codex, Codex caller gets claude, plain terminal gets codex", () => {
  assert.equal(detectCaller({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectCaller({ CODEX_SESSION_ID: "abc" }), "codex");
  assert.equal(detectCaller({ CODEX_THREAD_ID: "abc" }), "codex");
  assert.equal(detectCaller({}), null);
  assert.equal(resolveVia(null, { CLAUDECODE: "1" }), "codex");
  assert.equal(resolveVia(null, { CODEX_SESSION_ID: "x" }), "claude");
  assert.equal(resolveVia(null, {}), "codex");
});

test("routing: --via wins over detection and accepts vendor/model aliases", () => {
  assert.equal(resolveVia("claude", { CLAUDECODE: "1" }), "claude");
  assert.equal(resolveVia("fable", {}), "claude");
  assert.equal(resolveVia("astra", { CODEX_SESSION_ID: "x" }), "codex");
  assert.equal(resolveVia("BOTH", {}), "both");
});

test("routing: both-mode arbiter is the caller's opposite", () => {
  assert.deepEqual(backendsFor("both"), ["claude", "codex"]);
  assert.deepEqual(backendsFor("claude"), ["claude"]);
  assert.equal(mergerFor("both", { CLAUDECODE: "1" }), "codex");
  assert.equal(mergerFor("both", { CODEX_SESSION_ID: "x" }), "claude");
  assert.equal(mergerFor("both", {}), "codex");
  assert.equal(mergerFor("claude", { CLAUDECODE: "1" }), "claude");
});

test("reviewerLabel names the model only when overridden", () => {
  const defaults = { claude: BACKENDS.claude.defaultModel, codex: BACKENDS.codex.defaultModel };
  assert.equal(reviewerLabel("codex", defaults), "Astra");
  assert.equal(reviewerLabel("both", defaults), "Fable + Astra");
  assert.equal(reviewerLabel("claude", { ...defaults, claude: "claude-opus-5-5" }), "Fable (claude-opus-5-5)");
});

test("effort: max is Claude-only; both-mode takes the intersection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-check-test-effort-"));
  const { repo } = makeTempRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  const env = { CROSS_CHECK_STATE_DIR: dir, CLAUDECODE: "", CODEX_SESSION_ID: "" };
  const okClaude = runCli(["review", "--dry-run", "--via", "claude", "--effort", "max"], { cwd: repo, env });
  assert.equal(okClaude.status, 0, okClaude.stderr);
  const badCodex = runCli(["review", "--dry-run", "--via", "codex", "--effort", "max"], { cwd: repo, env });
  assert.notEqual(badCodex.status, 0);
  assert.match(badCodex.stderr, /Unsupported effort "max" for --via codex/);
  const badBoth = runCli(["review", "--dry-run", "--via", "both", "--effort", "max"], { cwd: repo, env });
  assert.match(badBoth.stderr, /low, medium, high, xhigh\./);
  const badModel = runCli(["review", "--dry-run", "--via", "both", "--model", "x"], { cwd: repo, env });
  assert.match(badModel.stderr, /--model cannot be combined with --via both/);
  assert.equal(codexEffort("max"), "xhigh");
  assert.equal(codexEffort("low"), "low");
});

test("dry-run reports the routing line and defaults to Astra outside any agent", () => {
  const { repo } = makeTempRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  const env = { CROSS_CHECK_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "cross-check-test-route-")), CLAUDECODE: "", CODEX_SESSION_ID: "" };
  const plain = runCli(["review", "--dry-run"], { cwd: repo, env });
  assert.match(plain.stdout, /via codex → Astra \| effort medium/);
  const fromClaude = runCli(["review", "--dry-run"], { cwd: repo, env: { ...env, CLAUDECODE: "1" } });
  assert.match(fromClaude.stdout, /via codex → Astra/);
  const fromCodex = runCli(["ask", "--dry-run", "why?"], { cwd: repo, env: { ...env, CODEX_SESSION_ID: "t" } });
  assert.match(fromCodex.stdout, /via claude → Fable/);
  const both = runCli(["review", "--dry-run", "--via", "both", "--deep"], { cwd: repo, env: { ...env, CLAUDECODE: "1" } });
  assert.match(both.stdout, /via both → Fable \+ Astra .* arbiter Astra/);
  // the prompt names the reviewer, never the other vendor
  assert.match(plain.stdout, /You are Codex Astra,/);
  assert.match(fromCodex.stdout, /You are Claude Fable,/);
});

// ---------------------------------------------------------------------------
// codex --json event reduction (recorded shapes from codex-cli 0.142 / 0.160)

test("codexEventReducer turns JSONL events into progress + a claude-shaped envelope", () => {
  const reducer = codexEventReducer("/repo");
  const emitted = [];
  const state = { toolCalls: 0, lastNote: "", lastEventAtMs: 0 };
  const ctx = { emit: (text, kind) => emitted.push([kind ?? "info", text]), state };
  const events = [
    { type: "thread.started", thread_id: "019b-thread" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "item_0", type: "command_execution", command: "/bin/bash -lc 'git diff'", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "/bin/bash -lc 'git diff'", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "item_1", type: "reasoning", text: "..." } },
    { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "draft" } },
    { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "{\"verdict\":\"approve\",\"summary\":\"ok\",\"findings\":[],\"next_steps\":[]}" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
  ];
  for (const e of events) reducer.handle(e, ctx);
  const envelope = reducer.finalize();
  assert.equal(state.toolCalls, 1);
  assert.equal(envelope.session_id, "019b-thread");
  assert.equal(envelope.error, null);
  assert.deepEqual(envelope.usage, { input_tokens: 10, output_tokens: 5 });
  assert.match(emitted.find(([k]) => k === "tool")[1], /tool #1: running: .*git diff/);
  // the LAST agent_message is the answer; extractStructured parses it like a claude envelope
  const data = normalizeReviewData(extractStructured(envelope));
  assert.equal(data.verdict, "approve");
});

test("codexEventReducer surfaces turn.failed as an envelope error", () => {
  const reducer = codexEventReducer("/repo");
  const ctx = { emit: () => {}, state: { toolCalls: 0, lastNote: "", lastEventAtMs: 0 } };
  reducer.handle({ type: "turn.failed", error: { message: "usage limit reached" } }, ctx);
  assert.equal(reducer.finalize().error, "usage limit reached");
});

test("normalizeReviewData keeps disagreements and renderReport prints them first", () => {
  const data = normalizeReviewData({
    verdict: "needs-attention",
    summary: "Reviewers mostly agree.",
    findings: [],
    next_steps: [],
    disagreements: ["Only Astra flagged the retry loop (kept, medium).", ""],
  });
  assert.deepEqual(data.disagreements, ["Only Astra flagged the retry loop (kept, medium)."]);
  const meta = {
    reviewLabel: "Review",
    reviewerLabel: "Fable + Astra",
    targetLabel: "working tree diff",
    reviewers: [
      { backend: "claude", model: "claude-fable-5", effort: "medium", role: null },
      { backend: "codex", model: "gpt-6-astra", effort: "medium", role: null },
      { backend: "codex", model: "gpt-6-astra", effort: "high", role: "arbiter" },
    ],
    sessions: [{ backend: "claude", id: "sess-1" }, { backend: "codex", id: "thr-1" }],
    costUsd: 0,
  };
  const out = renderReport(data, meta);
  assert.match(out, /^# Fable \+ Astra Review/);
  assert.match(out, /Reviewer: Astra \(gpt-6-astra, effort high, arbiter\)/);
  assert.ok(out.indexOf("Where they disagree:") < out.indexOf("No material findings."));
  assert.match(out, /Resume Fable interactively: claude -r sess-1/);
  assert.match(out, /Resume Astra interactively: codex exec resume thr-1/);
});
