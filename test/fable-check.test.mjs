// Offline regression tests for fable-check's fragile layers: structured-output
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
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fable-check-test-state-"));
process.env.FABLE_CHECK_STATE_DIR = STATE_DIR;

const SCRIPT = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "skill",
  "scripts",
  "fable-check.mjs"
);
const {
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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fable-check-test-repo-"));
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
// dead-worker reconciliation (temp state dir via FABLE_CHECK_STATE_DIR)

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
  const dir = jobsDir(fs.mkdtempSync(path.join(os.tmpdir(), "fable-check-test-r1-")));
  seedJob(dir, { id: "rev-dead0001", status: "running", pid: deadPid() });
  const reconciled = reconcileDeadJob(dir, readJob(dir, "rev-dead0001"));
  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.error, "worker process died");
  assert.equal(reconciled.pid, null);
  assert.equal(readJob(dir, "rev-dead0001").status, "failed");
  assert.match(fs.readFileSync(reconciled.reportFile, "utf8"), /worker process died/);
});

test("reconcileDeadJob leaves live, own-process, and finished jobs alone", () => {
  const dir = jobsDir(fs.mkdtempSync(path.join(os.tmpdir(), "fable-check-test-r2-")));
  seedJob(dir, { id: "rev-own00001", status: "running", pid: process.pid });
  seedJob(dir, { id: "rev-done0001", status: "completed", pid: null });
  assert.equal(reconcileDeadJob(dir, readJob(dir, "rev-own00001")).status, "running");
  assert.equal(reconcileDeadJob(dir, readJob(dir, "rev-done0001")).status, "completed");
});

test("reconcileDeadJob never clobbers an outcome written after our stale read", () => {
  const dir = jobsDir(fs.mkdtempSync(path.join(os.tmpdir(), "fable-check-test-r4-")));
  // On disk the worker already finished; our in-memory copy is a stale
  // "running" read with a now-dead pid.
  seedJob(dir, { id: "rev-race0001", status: "completed", pid: null, verdict: "approve" });
  const stale = { ...readJob(dir, "rev-race0001"), status: "running", pid: deadPid() };
  const reconciled = reconcileDeadJob(dir, stale);
  assert.equal(reconciled.status, "completed");
  assert.equal(readJob(dir, "rev-race0001").status, "completed");
});

test("listJobs reconciles dead workers as a side effect", () => {
  const dir = jobsDir(fs.mkdtempSync(path.join(os.tmpdir(), "fable-check-test-r3-")));
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fable-check-test-cli-"));
  const env = { FABLE_CHECK_STATE_DIR: stateDir };
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
    env: { FABLE_CHECK_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fable-check-test-dr-")) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry run \(no claude call, no job created\)/);
  assert.match(result.stdout, /working tree diff/);
  assert.match(result.stdout, /assembled prompt below/);
  assert.match(result.stdout, /changed/); // the diff made it into the prompt
});

test("ask --dry-run prints the assembled advisory prompt", () => {
  const { repo } = makeTempRepo();
  const result = runCli(["ask", "--dry-run", "is the design sound?"], {
    cwd: repo,
    env: { FABLE_CHECK_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fable-check-test-da-")) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /is the design sound\?/);
  assert.match(result.stdout, /assembled prompt below/);
});
