#!/usr/bin/env node
// cross-check — extensive code review by the *other* vendor's model.
// Claude Code callers get a Codex (gpt-6-astra) review; Codex callers get a
// Claude (Fable) review; `--via both` runs both and merges. Each backend runs
// its local CLI headlessly with read-only tools; auth rides on the user's
// existing logins. Portions of the prompt/schema design are adapted from
// openai/codex-plugin-cc (Apache-2.0) — see NOTICE.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCHEMA_PATH = path.join(SKILL_ROOT, "schemas", "review-output.schema.json");
// CROSS_CHECK_STATE_DIR exists so tests can run against a throwaway state dir.
const STATE_ROOT =
  process.env.CROSS_CHECK_STATE_DIR || process.env.FABLE_CHECK_STATE_DIR || path.join(os.homedir(), ".cross-check", "jobs");

const DEFAULT_EFFORT = "medium";
const MERGE_EFFORT = "high";
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const MAX_INLINE_DIFF_BYTES = 400 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 48 * 1024;
const MODEL_TIMEOUT_MS = 45 * 60 * 1000;
const HEARTBEAT_MS =
  Number(process.env.CROSS_CHECK_HEARTBEAT_MS) > 0
    ? Number(process.env.CROSS_CHECK_HEARTBEAT_MS)
    : 20 * 1000;
const JOB_WRITE_THROTTLE_MS = 1500;
const STALL_WARN_MS = 5 * 60 * 1000;

// Read-only surface for the headless reviewer. Anything not listed is denied.
const ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status)",
  "Bash(git status:*)",
  "Bash(git ls-files:*)",
  "Bash(git blame:*)",
  "Bash(git rev-parse:*)",
  "Bash(git merge-base:*)",
  "Bash(git branch:*)",
].join(",");
const DISALLOWED_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
  "Task",
  "Agent",
  "WebSearch",
  "WebFetch",
  "KillShell",
].join(",");

// ---------------------------------------------------------------------------
// backends. Each runs one prompt headlessly with read-only tools and resolves
// to the same shape: { status, stdout, stderr, durationMs, timedOut, toolCalls,
// envelope: { result, structured_output?, session_id?, total_cost_usd? } }.

const BACKENDS = {
  claude: {
    key: "claude",
    label: "Fable",
    vendor: "Claude",
    defaultModel: "claude-fable-5",
    efforts: new Set(["low", "medium", "high", "xhigh", "max"]),
    run: (opts) => runClaude(opts),
    ensure: () => ensureClaudeAvailable(),
    resumeHint: (id) => `claude -r ${id}`,
  },
  codex: {
    key: "codex",
    label: "Astra",
    vendor: "Codex",
    defaultModel: "gpt-6-astra",
    efforts: new Set(["low", "medium", "high", "xhigh"]),
    run: (opts) => runCodex(opts),
    ensure: () => ensureCodexAvailable(),
    resumeHint: (id) => `codex exec resume ${id}`,
  },
};
const OPPOSITE = { claude: "codex", codex: "claude" };

// Which backend reviews. Explicit --via wins. Otherwise the caller's opposite:
// inside Claude Code (CLAUDECODE set) → codex; inside Codex (CODEX_SESSION_ID
// or CODEX_THREAD_ID set) → claude; a plain terminal → codex.
function detectCaller(env = process.env) {
  if (env.CLAUDECODE) return "claude";
  if (env.CODEX_SESSION_ID || env.CODEX_THREAD_ID) return "codex";
  return null;
}
function resolveVia(flag, env = process.env) {
  if (flag) {
    const via = String(flag).toLowerCase();
    if (via === "fable" || via === "anthropic") return "claude";
    if (via === "astra" || via === "openai") return "codex";
    if (via === "claude" || via === "codex" || via === "both") return via;
    fail(`Unsupported --via "${flag}". Use claude, codex, or both.`);
  }
  const caller = detectCaller(env);
  return caller ? OPPOSITE[caller] : "codex";
}
// Backends a `via` value expands to, in a stable order.
function backendsFor(via) {
  return via === "both" ? ["claude", "codex"] : [via];
}
// In both-mode the merge pass runs on the caller's opposite (the model the
// single-backend path would have used), so a Claude caller never has Claude
// grade its own review.
function mergerFor(via, env = process.env) {
  if (via !== "both") return via;
  return resolveVia(null, env);
}
function reviewerLabel(via, models = {}) {
  return backendsFor(via)
    .map((b) => (models[b] && models[b] !== BACKENDS[b].defaultModel ? `${BACKENDS[b].label} (${models[b]})` : BACKENDS[b].label))
    .join(" + ");
}

const LENSES = [
  {
    key: "correctness",
    label: "Correctness",
    emphasis:
      "logic errors, wrong conditions, off-by-one and boundary mistakes, broken control flow, incorrect API usage, type mismatches, results that differ from the stated intent of the change",
  },
  {
    key: "security",
    label: "Security & data safety",
    emphasis:
      "injection, auth/permission gaps, secrets exposure, unsafe deserialization or file handling, data loss or corruption, irreversible state changes, missing validation at trust boundaries",
  },
  {
    key: "resilience",
    label: "Design & failure modes",
    emphasis:
      "unhandled errors, empty/null/timeout paths, race conditions and re-entrancy, retry and idempotency gaps, schema/config drift, stale references left behind by renames or deletions, compatibility regressions",
  },
];

// ---------------------------------------------------------------------------
// small utilities

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function nowIso() {
  return new Date().toISOString();
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

// Hosts sometimes pass every argument as one quoted string; split it shell-style.
function splitRawArgumentString(raw) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function normalizeArgv(argv) {
  if (argv.length === 1 && /\s/.test(argv[0] ?? "")) {
    return splitRawArgumentString(argv[0]);
  }
  return argv;
}

function parseArgs(argv, { valueFlags = [], boolFlags = [] } = {}) {
  const options = {};
  const positionals = [];
  const values = new Set(valueFlags);
  const bools = new Set(boolFlags);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (bools.has(name)) {
        options[name] = true;
      } else if (values.has(name)) {
        if (eq !== -1) {
          options[name] = arg.slice(eq + 1);
        } else {
          options[name] = argv[++i];
          if (options[name] === undefined) fail(`Missing value for --${name}.`);
        }
      } else {
        fail(`Unknown flag --${name}. Run \`cross-check.mjs help\` for usage.`);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { options, positionals };
}

// ---------------------------------------------------------------------------
// git helpers

function git(cwd, args, opts = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function gitChecked(cwd, args) {
  const result = git(cwd, args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error && result.error.code === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("cross-check must run inside a Git repository.");
  }
  return result.stdout.trim();
}

function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).trim() || "HEAD";
}

function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const head = symbolic.stdout.trim();
    if (head.startsWith("refs/remotes/origin/")) {
      return head.replace("refs/remotes/origin/", "");
    }
  }
  for (const candidate of ["main", "master", "trunk"]) {
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]).status === 0) {
      return candidate;
    }
    if (
      git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]).status === 0
    ) {
      return `origin/${candidate}`;
    }
  }
  throw new Error(
    "Unable to detect the default branch. Pass --base <ref> or use --scope working-tree."
  );
}

function getWorkingTreeState(cwd) {
  const lines = (out) => out.trim().split("\n").filter(Boolean);
  const staged = lines(gitChecked(cwd, ["diff", "--cached", "--name-only"]));
  const unstaged = lines(gitChecked(cwd, ["diff", "--name-only"]));
  const untracked = lines(gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]));
  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
  };
}

function resolveReviewTarget(cwd, { base = null, scope = "auto" } = {}) {
  ensureGitRepository(cwd);
  if (base) {
    return { mode: "branch", label: `branch diff against ${base}`, baseRef: base };
  }
  if (scope === "working-tree") {
    return { mode: "working-tree", label: "working tree diff" };
  }
  if (scope === "branch") {
    const detected = detectDefaultBranch(cwd);
    return { mode: "branch", label: `branch diff against ${detected}`, baseRef: detected };
  }
  if (scope !== "auto") {
    throw new Error(`Unsupported --scope "${scope}". Use auto, working-tree, or branch.`);
  }
  if (getWorkingTreeState(cwd).isDirty) {
    return { mode: "working-tree", label: "working tree diff" };
  }
  const detected = detectDefaultBranch(cwd);
  return { mode: "branch", label: `branch diff against ${detected}`, baseRef: detected };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function looksBinary(buffer) {
  const probe = buffer.subarray(0, 8000);
  return probe.includes(0);
}

function formatUntrackedFile(repoRoot, relativePath) {
  const absolute = path.join(repoRoot, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable)`;
  }
  if (stat.isDirectory()) return `### ${relativePath}\n(skipped: directory)`;
  if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes — read it with the Read tool if relevant)`;
  }
  let buffer;
  try {
    buffer = fs.readFileSync(absolute);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable)`;
  }
  if (looksBinary(buffer)) return `### ${relativePath}\n(skipped: binary file)`;
  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectReviewContext(cwd, target) {
  const repoRoot = ensureGitRepository(cwd);
  const branch = getCurrentBranch(repoRoot);

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    const status = gitChecked(repoRoot, ["status", "--short", "--untracked-files=all"]);
    const stagedDiff = gitChecked(repoRoot, ["diff", "--cached", "--no-ext-diff"]);
    const unstagedDiff = gitChecked(repoRoot, ["diff", "--no-ext-diff"]);
    const diffBytes = Buffer.byteLength(stagedDiff) + Buffer.byteLength(unstagedDiff);
    const inline = diffBytes <= MAX_INLINE_DIFF_BYTES;
    const untrackedBody = state.untracked
      .map((f) => formatUntrackedFile(repoRoot, f))
      .join("\n\n");

    const parts = [formatSection("Git Status", status)];
    if (inline) {
      parts.push(formatSection("Staged Diff", stagedDiff));
      parts.push(formatSection("Unstaged Diff", unstagedDiff));
      parts.push(formatSection("Untracked Files", untrackedBody));
    } else {
      parts.push(
        formatSection("Staged Diff Stat", gitChecked(repoRoot, ["diff", "--shortstat", "--cached"]))
      );
      parts.push(formatSection("Unstaged Diff Stat", gitChecked(repoRoot, ["diff", "--shortstat"])));
      parts.push(formatSection("Untracked Files", state.untracked.join("\n")));
    }

    const fileCount =
      new Set([...state.staged, ...state.unstaged, ...state.untracked]).size;
    return {
      repoRoot,
      branch,
      target,
      fileCount,
      inline,
      collectionGuidance: inline
        ? "Use the repository context below as primary evidence; read surrounding files with your tools where the diff alone is not enough."
        : "The repository context below is a summary only — the diff was too large to inline. Collect it yourself with `git diff --cached` and `git diff` (and Read for untracked files) before forming any conclusion.",
      content: parts.join("\n"),
      summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s) on ${branch}.`,
    };
  }

  const mergeBase = gitChecked(repoRoot, ["merge-base", "HEAD", target.baseRef]).trim();
  const range = `${mergeBase}..HEAD`;
  const logOutput = gitChecked(repoRoot, ["log", "--oneline", "--decorate", range]);
  const diffStat = gitChecked(repoRoot, ["diff", "--stat", range]);
  const changedFiles = gitChecked(repoRoot, ["diff", "--name-only", range])
    .trim()
    .split("\n")
    .filter(Boolean);
  const branchDiff = gitChecked(repoRoot, ["diff", "--no-ext-diff", range]);
  const inline = Buffer.byteLength(branchDiff) <= MAX_INLINE_DIFF_BYTES;

  const parts = [formatSection("Commit Log", logOutput), formatSection("Diff Stat", diffStat)];
  if (inline) {
    parts.push(formatSection("Branch Diff", branchDiff));
  } else {
    parts.push(formatSection("Changed Files", changedFiles.join("\n")));
  }

  return {
    repoRoot,
    branch,
    target,
    fileCount: changedFiles.length,
    inline,
    collectionGuidance: inline
      ? "Use the repository context below as primary evidence; read surrounding files with your tools where the diff alone is not enough."
      : `The repository context below is a summary only — the diff was too large to inline. Collect it yourself with \`git diff ${mergeBase}..HEAD\` (per-file if needed) before forming any conclusion.`,
    content: parts.join("\n"),
    summary: `Reviewing branch ${branch} against ${target.baseRef} from merge-base ${mergeBase.slice(0, 12)}.`,
  };
}

// ---------------------------------------------------------------------------
// prompt assembly

function loadPrompt(name) {
  return fs.readFileSync(path.join(SKILL_ROOT, "prompts", `${name}.md`), "utf8");
}

function interpolate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : ""
  );
}

function buildLensBlock(lens) {
  if (!lens) return "";
  return [
    "",
    "<lens>",
    `This pass is one of several independent passes over the same change; each concentrates on a different failure class.`,
    `Your lens: ${lens.label} — concentrate exclusively on ${lens.emphasis}.`,
    "Report only findings inside this lens; other passes cover the rest.",
    "</lens>",
    "",
  ].join("\n");
}

function reviewerName(backend) {
  return `${BACKENDS[backend].vendor} ${BACKENDS[backend].label}`;
}

function buildReviewPrompt({ adversarial, context, focusText, lens, backend }) {
  const template = loadPrompt(adversarial ? "adversarial-review" : "review");
  return interpolate(template, {
    REVIEWER: reviewerName(backend ?? "claude"),
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
    LENS_BLOCK: buildLensBlock(lens),
  });
}

// ---------------------------------------------------------------------------
// headless claude invocation

function summarizeToolUse(name, input, cwd) {
  const rel = (p) => {
    const text = String(p ?? "");
    return cwd && text.startsWith(`${cwd}/`) ? text.slice(cwd.length + 1) : text;
  };
  if (name === "Read") return `reading ${rel(input?.file_path)}`;
  if (name === "Grep") {
    return `searching for "${shorten(input?.pattern, 40)}"${input?.path ? ` in ${rel(input.path)}` : ""}`;
  }
  if (name === "Glob") return `listing files matching ${shorten(input?.pattern, 40)}`;
  if (name === "Bash") return `running \`${shorten(input?.command, 80)}\``;
  return `${name} ${shorten(JSON.stringify(input ?? {}), 60)}`;
}

// Spawned claude processes, tracked so cancellation (signal or cancelled job
// state) can terminate them instead of orphaning them to burn usage.
const ACTIVE_CHILDREN = new Set();

function killActiveChildren() {
  for (const child of ACTIVE_CHILDREN) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

// Only when running as the CLI — importers (tests) must not inherit handlers
// that call process.exit. isDirectInvocation is hoisted from the file bottom.
if (isDirectInvocation()) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      killActiveChildren();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

// Runs the claude CLI with stream-json output so progress is observable while
// the model works. The final "result" event carries the same envelope fields
// as --output-format json (result, structured_output, session_id, cost).
function runModel({ backend, ...opts }) {
  const impl = BACKENDS[backend];
  if (!impl) throw new Error(`Unknown backend "${backend}"`);
  return impl.run(opts);
}

// Shared plumbing for both CLIs: spawn, feed the prompt on stdin, parse JSONL
// events, heartbeat during silent thinking, enforce the timeout.
function runCli({ command, args, cwd, prompt, label, onProgress, handleEvent, finalize }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    ACTIVE_CHILDREN.add(child);
    let stderr = "";
    let lineBuffer = "";
    let rawStdout = "";
    let timedOut = false;
    const state = { toolCalls: 0, lastNote: "starting up", lastEventAtMs: Date.now() };
    let lastEmitAt = Date.now();

    const emit = (text, kind = "info", eventAgeMs = 0) => {
      lastEmitAt = Date.now();
      onProgress?.(text, { kind, toolCalls: state.toolCalls, eventAgeMs });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, MODEL_TIMEOUT_MS);

    // Long thinking stretches produce no events; the heartbeat keeps callers
    // (and watching agents) from mistaking that for a stall.
    const heartbeat = setInterval(() => {
      if (Date.now() - lastEmitAt < Math.max(0, HEARTBEAT_MS - 2000)) return;
      const eventAgeMs = Date.now() - state.lastEventAtMs;
      const idleNote = eventAgeMs > 60_000 ? ` (no model events for ${formatElapsed(eventAgeMs)})` : "";
      emit(
        `still working — ${formatElapsed(Date.now() - started)} elapsed, ${state.toolCalls} tool call(s) so far, last: ${state.lastNote}${idleNote}`,
        "heartbeat",
        eventAgeMs
      );
    }, HEARTBEAT_MS);

    const consume = (text) => {
      lineBuffer += text;
      let newline;
      while ((newline = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          state.lastEventAtMs = Date.now();
          handleEvent(JSON.parse(line), { emit, state });
        } catch {
          // non-JSON noise on stdout; ignore
        }
      }
    };

    const finish = (status, extraStderr = "") => {
      ACTIVE_CHILDREN.delete(child);
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (lineBuffer.trim()) consume("\n");
      resolve({
        status,
        stdout: rawStdout,
        stderr: extraStderr ? `${stderr}\n${extraStderr}` : stderr,
        durationMs: Date.now() - started,
        timedOut,
        toolCalls: state.toolCalls,
        envelope: finalize(),
      });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      rawStdout += chunk;
      consume(chunk);
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => finish(1, error.message));
    child.on("close", (code) => finish(code ?? 1));

    child.stdin.write(prompt);
    child.stdin.end();
    emit(`${label} started (pid=${child.pid})`);
  });
}

function withSchemaPrompt(prompt) {
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  // Agentic runs don't reliably enforce a schema flag on either CLI, so the
  // schema also goes into the prompt verbatim — exact field names, exact enums.
  return `${prompt}\n\n<output_schema>\nYour final message must be exactly one JSON object conforming to this JSON Schema — no markdown fences, no prose before or after, no extra or renamed fields:\n${schema}\n</output_schema>\n`;
}

// Reduces codex `--json` JSONL events into progress + a claude-shaped envelope.
// Exported for tests (pure: no process state).
function codexEventReducer(cwd) {
  const acc = { threadId: null, lastMessage: "", usage: null, error: null };
  return {
    handle(event, { emit, state }) {
      const item = event.item ?? {};
      if (event.type === "thread.started") {
        acc.threadId = event.thread_id ?? null;
        emit(`session started (thread=${acc.threadId ?? "?"})`);
        return;
      }
      if (event.type === "item.started" && item.type === "command_execution") {
        state.toolCalls += 1;
        state.lastNote = `running: ${shorten(String(item.command ?? ""), 96)}`;
        emit(`tool #${state.toolCalls}: ${state.lastNote}`, "tool");
        return;
      }
      if (event.type === "item.started" && (item.type === "file_read" || item.type === "web_search")) {
        state.toolCalls += 1;
        state.lastNote = `${item.type}: ${shorten(String(item.path ?? item.query ?? ""), 96)}`;
        emit(`tool #${state.toolCalls}: ${state.lastNote}`, "tool");
        return;
      }
      if (event.type === "item.completed" && item.type === "reasoning") {
        state.lastNote = "thinking";
        return;
      }
      if (event.type === "item.completed" && item.type === "agent_message") {
        acc.lastMessage = typeof item.text === "string" ? item.text : acc.lastMessage;
        return;
      }
      if (event.type === "turn.completed") {
        acc.usage = event.usage ?? null;
        return;
      }
      if (event.type === "turn.failed" || event.type === "error") {
        acc.error = event.error?.message ?? event.message ?? "codex reported an error";
      }
    },
    finalize() {
      return {
        result: acc.lastMessage,
        session_id: acc.threadId,
        usage: acc.usage,
        error: acc.error,
      };
    },
  };
}

function codexEffort(effort) {
  return effort === "max" ? "xhigh" : effort;
}

function runCodex({ prompt, cwd, model, effort, withSchema = true, onProgress }) {
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--json",
    "--skip-git-repo-check",
    "--model",
    model,
    "-c",
    `model_reasoning_effort="${codexEffort(effort)}"`,
  ];
  let fullPrompt = prompt;
  if (withSchema) {
    fullPrompt = withSchemaPrompt(prompt);
    args.push("--output-schema", SCHEMA_PATH);
  }
  args.push("-"); // prompt on stdin
  const reducer = codexEventReducer(cwd);
  return runCli({
    command: "codex",
    args,
    cwd,
    prompt: fullPrompt,
    label: `codex (model=${model}, effort=${codexEffort(effort)})`,
    onProgress,
    handleEvent: reducer.handle,
    finalize: reducer.finalize,
  }).then((result) => {
    // Surface turn.failed/error events as a non-zero status with the message in
    // stderr, so callers render a failure with a reason instead of an empty report.
    if (result.envelope?.error) {
      return { ...result, status: result.status || 1, stderr: `${result.stderr}\n${result.envelope.error}`.trim() };
    }
    return result;
  });
}

function runClaude({ prompt, cwd, model, effort, withSchema = true, onProgress }) {
  const args = [
    "-p",
    "--model",
    model,
    "--effort",
    effort,
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    ALLOWED_TOOLS,
    "--disallowedTools",
    DISALLOWED_TOOLS,
    "--permission-mode",
    "default",
  ];
  let fullPrompt = prompt;
  if (withSchema) {
    fullPrompt = withSchemaPrompt(prompt);
    // Claude Code's --json-schema validator rejects the `$schema` draft key.
    const { $schema: _drop, ...schema } = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
    args.push("--json-schema", JSON.stringify(schema));
  }
  let envelope = null;
  return runCli({
    command: "claude",
    args,
    cwd,
    prompt: fullPrompt,
    label: `claude (model=${model}, effort=${effort})`,
    onProgress,
    handleEvent(event, { emit, state }) {
      // Any event counts as proof of life — including thinking-token ticks,
      // which are the only events during long reasoning.
      if (event.type === "system" && event.subtype === "thinking_tokens") {
        if (event.estimated_tokens) state.lastNote = `thinking (~${event.estimated_tokens} tokens)`;
        return;
      }
      if (event.type === "system" && event.subtype === "init") {
        emit(`session started (model=${model}, effort=${effort})`);
        return;
      }
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "tool_use") {
            state.toolCalls += 1;
            state.lastNote = summarizeToolUse(block.name, block.input, cwd);
            emit(`tool #${state.toolCalls}: ${state.lastNote}`, "tool");
          }
        }
        return;
      }
      if (event.type === "result") envelope = event;
    },
    finalize: () => envelope,
  });
}

function extractStructured(envelope) {
  if (!envelope) return null;
  if (envelope.structured_output && typeof envelope.structured_output === "object") {
    return envelope.structured_output;
  }
  const text = typeof envelope.result === "string" ? envelope.result : "";
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.unshift(fenced[1]);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// report rendering

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_ALIASES = {
  blocker: "critical",
  critical: "critical",
  major: "high",
  high: "high",
  moderate: "medium",
  medium: "medium",
  minor: "low",
  low: "low",
  info: "low",
};
const VALID_CATEGORIES = new Set([
  "correctness",
  "security",
  "data-safety",
  "concurrency",
  "error-handling",
  "performance",
  "design",
  "compatibility",
  "other",
]);

// The CLI schema-validates when it can, but agentic runs sometimes fall back to
// loose JSON in `result` — normalize so the report never shows raw model output.
function normalizeReviewData(data) {
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const normalized = findings.map((raw, index) => {
    const f = raw && typeof raw === "object" ? raw : {};
    const severity =
      SEVERITY_ALIASES[String(f.severity ?? "").toLowerCase().trim()] ?? "low";
    const category = VALID_CATEGORIES.has(String(f.category ?? "").toLowerCase().trim())
      ? String(f.category).toLowerCase().trim()
      : "other";
    let lineStart = Number.isInteger(f.line_start) && f.line_start > 0 ? f.line_start : null;
    let lineEnd =
      Number.isInteger(f.line_end) && f.line_end >= (lineStart ?? 1) ? f.line_end : lineStart;
    if (!lineStart) {
      const range = String(f.lines ?? f.line ?? "").match(/(\d+)(?:\s*[-–]\s*(\d+))?/);
      if (range) {
        lineStart = Number(range[1]);
        lineEnd = range[2] ? Number(range[2]) : lineStart;
      }
    }
    const confidence =
      typeof f.confidence === "number" ? Math.min(1, Math.max(0, f.confidence)) : 0.5;
    return {
      severity,
      category,
      title: String(f.title ?? `Finding ${index + 1}`).trim() || `Finding ${index + 1}`,
      body: String(f.body ?? f.details ?? f.description ?? "No details provided.").trim(),
      file: String(f.file ?? f.path ?? "unknown").trim() || "unknown",
      line_start: lineStart,
      line_end: lineEnd,
      confidence,
      recommendation: String(f.recommendation ?? f.fix ?? f.suggestion ?? "").trim(),
    };
  });
  const verdictText = String(data.verdict ?? data.status ?? data.assessment ?? "")
    .toLowerCase()
    .trim();
  return {
    verdict: ["approve", "approved", "ship", "pass"].includes(verdictText)
      ? "approve"
      : "needs-attention",
    summary: String(data.summary ?? "").trim() || "No summary provided.",
    findings: normalized,
    next_steps: (Array.isArray(data.next_steps) ? data.next_steps : [])
      .map((s) => String(s).trim())
      .filter(Boolean),
    disagreements: (Array.isArray(data.disagreements) ? data.disagreements : [])
      .map((s) => String(s).trim())
      .filter(Boolean),
  };
}

function formatLineRange(finding) {
  if (!finding.line_start) return "";
  if (!finding.line_end || finding.line_end === finding.line_start) return `:${finding.line_start}`;
  return `:${finding.line_start}-${finding.line_end}`;
}

function jobStampLine(meta) {
  if (!meta.jobId) return null;
  return `Job: ${meta.jobId}${meta.createdAt ? ` | created ${meta.createdAt}` : ""}`;
}

function reviewerStampLines(meta) {
  const lines = [];
  for (const r of meta.reviewers ?? []) {
    lines.push(`Reviewer: ${BACKENDS[r.backend].label} (${r.model}, effort ${r.effort}${r.role ? `, ${r.role}` : ""})`);
  }
  return lines;
}

function renderReport(data, meta) {
  const stamp = jobStampLine(meta);
  const lines = [
    `# ${meta.reviewerLabel ?? "Fable"} ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ...reviewerStampLines(meta),
    ...(stamp ? [stamp] : []),
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    "",
  ];

  if ((data.disagreements ?? []).length > 0) {
    lines.push("Where they disagree:");
    for (const d of data.disagreements) lines.push(`- ${d}`);
    lines.push("");
  } else if (meta.reviewers?.length > 1) {
    lines.push("Where they disagree: nothing material.", "");
  }

  const findings = [...(data.findings ?? [])].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
  );

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const confidence = Math.round((finding.confidence ?? 0) * 100);
      lines.push(
        `- [${finding.severity}/${finding.category ?? "other"}] ${finding.title} (${finding.file}${formatLineRange(finding)}, confidence ${confidence}%)`
      );
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) lines.push(`  Recommendation: ${finding.recommendation}`);
    }
  }

  if ((data.next_steps ?? []).length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) lines.push(`- ${step}`);
  }

  lines.push(...resumeLines(meta));
  if (meta.costUsd) {
    lines.push(`Estimated cost: $${meta.costUsd.toFixed(2)} (Claude side only; Codex usage counts against its weekly limit)`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function resumeLines(meta) {
  const out = [];
  const seen = new Set();
  for (const { backend, id } of [...(meta.sessions ?? [])].reverse()) {
    if (!id || seen.has(backend)) continue;
    seen.add(backend);
    out.push(`Resume ${BACKENDS[backend].label} interactively: ${BACKENDS[backend].resumeHint(id)}`);
  }
  return out.length ? ["", ...out] : [];
}

function renderFailure(meta, detail, rawText) {
  const stamp = jobStampLine(meta);
  const lines = [
    `# ${meta.reviewerLabel ?? "Fable"} ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ...reviewerStampLines(meta),
    ...(stamp ? [stamp] : []),
    "The reviewer did not return a valid structured result.",
    "",
    `- Detail: ${detail}`,
  ];
  if (rawText) lines.push("", "Raw output:", "", "```text", shorten(rawText, 4000), "```");
  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// job state

function repoSlug(repoRoot) {
  const hash = crypto.createHash("sha1").update(repoRoot).digest("hex").slice(0, 8);
  return `${path.basename(repoRoot)}-${hash}`;
}

function jobsDir(repoRoot) {
  const dir = path.join(STATE_ROOT, repoSlug(repoRoot));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function newJobId() {
  return `rev-${crypto.randomBytes(4).toString("hex")}`;
}

function jobFilePath(dir, id) {
  return path.join(dir, `${id}.json`);
}

// Atomic write: `status` is polled from other processes, and a plain
// writeFileSync can be read mid-truncation as an empty/torn file.
function writeJob(dir, job) {
  const file = jobFilePath(dir, job.id);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, file);
}

function readJob(dir, id) {
  try {
    return JSON.parse(fs.readFileSync(jobFilePath(dir, id), "utf8"));
  } catch {
    return null;
  }
}

function listJobs(dir) {
  let entries = [];
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".data.json"));
  } catch {
    return [];
  }
  const jobs = entries
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((job) => reconcileDeadJob(dir, job));
  return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function appendLog(logFile, line) {
  try {
    fs.appendFileSync(logFile, `[${nowIso()}] ${line}\n`);
  } catch {
    // logging must never break the run
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Reconcile stale state: a job marked running whose process died.
function effectiveStatus(job) {
  if (job.status === "running" && !isAlive(job.pid)) return "failed (worker died)";
  return job.status;
}

// A running/queued job whose worker process is gone (machine sleep, reboot,
// kill -9) would otherwise stay "running" forever: `status` calls it dead but
// `result` refuses to serve it. Persist the failure so every command agrees.
function reconcileDeadJob(dir, job) {
  if (!job) return job;
  const isActive = (j) => j.status === "running" || j.status === "queued";
  if (!isActive(job) || !job.pid || job.pid === process.pid || isAlive(job.pid)) return job;
  // The worker may have written its real outcome (completed/failed/cancelled)
  // between our read and the liveness check — re-read and only reconcile a job
  // that is still active on disk, so we never clobber a genuine result.
  const onDisk = readJob(dir, job.id);
  if (onDisk && !isActive(onDisk)) return onDisk;
  job.status = "failed";
  job.error = "worker process died";
  job.completedAt = nowIso();
  job.pid = null;
  job.progress = { ...job.progress, phase: "worker died" };
  try {
    if (job.reportFile && !fs.existsSync(job.reportFile)) {
      fs.writeFileSync(
        job.reportFile,
        `# Fable ${job.kind === "advisory" ? "Advisory" : "Review"}\n\nJob: ${job.id} | created ${job.createdAt}\n\nRun failed: the worker process died before finishing (machine sleep, reboot, or it was killed). Re-run the ${job.kind === "advisory" ? "question" : "review"} to get a report.\n`
      );
    }
    writeJob(dir, job);
    appendLog(job.logFile, "worker process died — job marked failed");
  } catch {
    // reconcile must never break a read path
  }
  return job;
}

// Fans every progress line out to three sinks: the job log file (always), the
// job JSON's `progress` field (throttled, so `status` shows live state), and
// stderr when running in the foreground (so the invoking agent or terminal
// sees continuous activity instead of silence).
//
// Persisting also doubles as the cooperative-cancel checkpoint: before each
// write it re-reads the on-disk job, and if another process marked it
// cancelled, it kills the claude children and exits instead of overwriting
// the cancellation.
function createReporter({ dir, job, interactive }) {
  let toolCalls = 0;
  let lastJobWrite = 0;
  const persist = (force) => {
    const now = Date.now();
    if (!force && now - lastJobWrite < JOB_WRITE_THROTTLE_MS) return;
    lastJobWrite = now;
    const onDisk = readJob(dir, job.id);
    if (onDisk?.status === "cancelled") {
      appendLog(job.logFile, "cancellation detected — stopping reviewers and exiting");
      if (interactive && !job.request?.quiet) {
        process.stderr.write("[cross-check] cancellation detected — stopping\n");
      }
      killActiveChildren();
      process.exit(1);
    }
    try {
      writeJob(dir, job);
    } catch {
      // progress persistence must never break the run
    }
  };
  const reporter = {
    line(text, { kind = "info", force = false, eventAgeMs = 0 } = {}) {
      if (kind === "tool") toolCalls += 1;
      appendLog(job.logFile, text);
      if (interactive && !job.request?.quiet) {
        process.stderr.write(`[cross-check] ${text}\n`);
      }
      // lastActivityAt is "when did the wrapper last say something" (display);
      // lastEventAt is "when did the model last show proof of life" (stall
      // detection). Heartbeats only refresh the latter via eventAgeMs, and it
      // only moves forward — parallel lens passes must not regress it.
      const candidateMs = kind === "heartbeat" ? Date.now() - eventAgeMs : Date.now();
      const existingMs = Date.parse(job.progress?.lastEventAt ?? "") || 0;
      job.progress = {
        ...job.progress,
        toolCalls,
        lastActivity: shorten(text, 140),
        lastActivityAt: nowIso(),
        lastEventAt: new Date(Math.max(candidateMs, existingMs)).toISOString(),
      };
      persist(force);
    },
    phase(name) {
      job.progress = { ...job.progress, phase: name };
      reporter.line(`phase: ${name}`, { force: true });
    },
    forModel(label) {
      const tag = label ? `[${label}] ` : "";
      return (text, meta = {}) =>
        reporter.line(`${tag}${text}`, { kind: meta.kind, eventAgeMs: meta.eventAgeMs ?? 0 });
    },
  };
  return reporter;
}

// ---------------------------------------------------------------------------
// the review pipeline

async function executeReview(request, { reporter, job }) {
  const cwd = request.cwd;
  reporter.phase("collecting change context");
  const target = resolveReviewTarget(cwd, { base: request.base, scope: request.scope });
  const context = collectReviewContext(cwd, target);
  reporter.line(`target: ${target.label}`);
  reporter.line(context.summary);
  reporter.line(`diff ${context.inline ? "inlined" : "too large — reviewer will self-collect"}`);
  reporter.line(
    request.deep
      ? "deep mode: expect roughly 5-15 minutes (3 parallel passes + merge); progress lines stream continuously"
      : "expect roughly 2-8 minutes depending on change size and effort; progress lines stream continuously"
  );

  const reviewLabel = request.deep
    ? "Deep Review"
    : request.adversarial
      ? "Adversarial Review"
      : "Review";
  const backends = backendsFor(request.via);
  const meta = {
    reviewLabel,
    reviewerLabel: reviewerLabel(request.via, request.models),
    targetLabel: target.label,
    jobId: job?.id ?? null,
    createdAt: job?.createdAt ?? null,
    reviewers: [],
    sessions: [],
    costUsd: 0,
  };
  const noteRun = (backend, model, effort, role, result) => {
    meta.reviewers.push({ backend, model, effort, role });
    if (result.envelope?.session_id) meta.sessions.push({ backend, id: result.envelope.session_id });
    if (typeof result.envelope?.total_cost_usd === "number") meta.costUsd += result.envelope.total_cost_usd;
  };

  const runPass = async (backend, lens) => {
    const prompt = buildReviewPrompt({
      adversarial: request.adversarial,
      context,
      focusText: request.focusText,
      lens,
      backend,
    });
    const model = request.models[backend];
    const tag = [backends.length > 1 ? BACKENDS[backend].label : null, lens?.key].filter(Boolean).join(":");
    const result = await runModel({
      backend,
      prompt,
      cwd: context.repoRoot,
      model,
      effort: request.effort,
      onProgress: reporter.forModel(tag || null),
    });
    noteRun(backend, model, request.effort, lens ? `lens ${lens.key}` : null, result);
    reporter.line(
      `pass${tag ? ` [${tag}]` : ""} finished in ${formatElapsed(result.durationMs)} (exit ${result.status}${result.timedOut ? ", timed out" : ""})`,
      { force: true }
    );
    return { backend, lens, result };
  };

  // Every (backend × lens) pass, run concurrently; a single-backend standard
  // review is the degenerate case of one pass with no merge.
  const lenses = request.deep ? LENSES : [null];
  const planned = backends.flatMap((b) => lenses.map((lens) => ({ backend: b, lens })));
  const needsMerge = planned.length > 1;
  if (needsMerge) {
    reporter.phase(
      `running ${planned.length} passes in parallel (${backends.map((b) => BACKENDS[b].label).join(" + ")}${request.deep ? " × correctness, security, design" : ""})`
    );
  } else {
    reporter.phase("review pass running (reading code, tracing data flow, verifying findings)");
  }
  let done = 0;
  const passes = await Promise.all(
    planned.map((p) =>
      runPass(p.backend, p.lens).then((r) => {
        done += 1;
        if (needsMerge) reporter.phase(`passes: ${done}/${planned.length} complete`);
        return r;
      })
    )
  );

  let finalResult;
  if (!needsMerge) {
    finalResult = passes[0].result;
  } else {
    // A pass only counts if the process succeeded AND produced a parseable
    // result; a structured message followed by a failure is not a review.
    const payloads = passes.map((p) => {
      const ok = p.result.status === 0 && !p.result.timedOut;
      return {
        label: [BACKENDS[p.backend].label, p.lens?.key].filter(Boolean).join(" / "),
        backend: p.backend,
        ok,
        result: ok ? extractStructured(p.result.envelope) : null,
        error: p.result.timedOut
          ? "timed out"
          : !ok
            ? shorten(p.result.stderr || `${p.backend} exited non-zero`, 400)
            : null,
      };
    });
    const usable = payloads.filter((p) => p.result);
    if (usable.length === 0) {
      const detail = payloads.map((p) => `${p.label}: ${p.error ?? "no structured output"}`).join("; ");
      return { ok: false, rendered: renderFailure(meta, detail, passes[0]?.result.envelope?.result), meta };
    }
    const failed = payloads.filter((p) => !p.result);
    for (const f of failed) reporter.line(`note: ${f.label} produced no usable result (${f.error ?? "no structured output"}); merging without it`, { force: true });

    const usableBackends = [...new Set(usable.map((p) => p.backend))];
    const twoReviewers = usableBackends.length > 1;
    const survivorNote = failed.length
      ? `${failed.map((f) => f.label).join(", ")} failed; report reflects ${usableBackends.map((b) => BACKENDS[b].label).join(" + ")} only.`
      : null;
    if (usable.length === 1) {
      // One surviving standard pass: nothing to merge, and calling a possibly
      // broken arbiter would throw the good review away.
      finalResult = passes.find((p) => p.backend === usable[0].backend && p.lens === null)?.result ?? passes[0].result;
      meta.note = survivorNote;
    } else {
    // The arbiter must be a backend that just worked; the designated one may
    // be the side that failed (quota, login), so fall back to a survivor.
    const designated = mergerFor(request.via);
    const merger = usableBackends.includes(designated) ? designated : usableBackends[0];
    reporter.phase(`merging ${usable.length}/${planned.length} passes into one report (arbiter: ${BACKENDS[merger].label})`);
    const mergePrompt = interpolate(loadPrompt(twoReviewers ? "merge-both" : "merge"), {
      REVIEWER: reviewerName(merger),
      REVIEWER_NAMES: usableBackends.map(reviewerName).join(" and "),
      PASS_COUNT: String(usable.length),
      TARGET_LABEL: target.label,
      PASS_RESULTS: usable
        .map((p) => `### ${twoReviewers ? "Reviewer" : "Lens"}: ${p.label}\n\`\`\`json\n${JSON.stringify(p.result, null, 2)}\n\`\`\``)
        .join("\n\n"),
      REVIEW_INPUT: context.content,
    });
    const mergeModel = request.models[merger];
    finalResult = await runModel({
      backend: merger,
      prompt: mergePrompt,
      cwd: context.repoRoot,
      model: mergeModel,
      effort: MERGE_EFFORT,
      onProgress: reporter.forModel("merge"),
    });
    noteRun(merger, mergeModel, MERGE_EFFORT, "arbiter", finalResult);
    if (backends.length > 1) meta.note = survivorNote;
    }
  }
  reporter.phase("rendering report");

  const finalOk = finalResult.status === 0 && !finalResult.timedOut;
  const raw = finalOk ? extractStructured(finalResult.envelope) : null;
  const looksLikeReview =
    raw &&
    (typeof raw.verdict === "string" ||
      typeof raw.status === "string" ||
      Array.isArray(raw.findings));
  const data = looksLikeReview ? normalizeReviewData(raw) : null;
  if (!data) {
    const detail = finalResult.timedOut
      ? "review timed out"
      : finalResult.status !== 0
        ? shorten(finalResult.stderr || "reviewer exited non-zero", 600)
        : "output did not match the review schema";
    return {
      ok: false,
      rendered: renderFailure(meta, detail, finalResult.envelope?.result ?? finalResult.stdout),
      meta,
      data: null,
    };
  }

  if (meta.note) data.summary = `${meta.note} ${data.summary}`;
  return { ok: true, rendered: renderReport(data, meta), meta, data };
}

function buildAdvisoryPrompt(repoRoot, question, backend = "claude") {
  const branch = getCurrentBranch(repoRoot);
  const gitStatus = gitChecked(repoRoot, ["status", "--short"]).trim() || "(clean)";
  let recentCommits = "(no commits yet)";
  try {
    recentCommits = gitChecked(repoRoot, ["log", "--oneline", "-15"]).trim() || recentCommits;
  } catch {
    // empty repo; keep the placeholder
  }
  const prompt = interpolate(loadPrompt("advise"), {
    REVIEWER: reviewerName(backend),
    QUESTION: question,
    BRANCH: branch,
    // length-truncate only; shorten() would collapse the line structure
    GIT_STATUS: gitStatus.length > 4000 ? `${gitStatus.slice(0, 4000)}\n...(truncated)` : gitStatus,
    RECENT_COMMITS: recentCommits,
  });
  return { prompt, branch };
}

// Advisory mode: same read-only reviewer harness, but the deliverable is a
// prose answer to a question instead of a structured findings report.
async function executeAdvisory(request, { reporter, job }) {
  const repoRoot = ensureGitRepository(request.cwd);
  reporter.phase("collecting repository orientation");
  const backends = backendsFor(request.via);
  const { branch } = buildAdvisoryPrompt(repoRoot, request.question, backends[0]);

  const meta = {
    reviewLabel: "Advisory",
    reviewerLabel: reviewerLabel(request.via, request.models),
    targetLabel: `question on ${branch}`,
    jobId: job?.id ?? null,
    createdAt: job?.createdAt ?? null,
    reviewers: [],
    sessions: [],
    costUsd: 0,
  };
  const noteRun = (backend, model, effort, role, result) => {
    meta.reviewers.push({ backend, model, effort, role });
    if (result.envelope?.session_id) meta.sessions.push({ backend, id: result.envelope.session_id });
    if (typeof result.envelope?.total_cost_usd === "number") meta.costUsd += result.envelope.total_cost_usd;
  };
  const answerOf = (result) => (typeof result.envelope?.result === "string" ? result.envelope.result.trim() : "");
  const failureDetail = (result, who) =>
    result.timedOut
      ? `${who} timed out`
      : result.status !== 0
        ? shorten(result.stderr || `${who} exited non-zero`, 600)
        : `${who} returned no answer text`;

  reporter.phase(
    backends.length > 1
      ? "both advisors exploring the repository in parallel"
      : "advisor exploring the repository and forming an answer"
  );
  reporter.line("expect roughly 1-6 minutes depending on the question; progress lines stream continuously");

  const runs = await Promise.all(
    backends.map(async (backend) => {
      const model = request.models[backend];
      const { prompt } = buildAdvisoryPrompt(repoRoot, request.question, backend);
      const result = await runModel({
        backend,
        prompt,
        cwd: repoRoot,
        model,
        effort: request.effort,
        withSchema: false,
        onProgress: reporter.forModel(backends.length > 1 ? BACKENDS[backend].label : null),
      });
      noteRun(backend, model, request.effort, null, result);
      reporter.line(
        `${BACKENDS[backend].label} finished in ${formatElapsed(result.durationMs)} (exit ${result.status}${result.timedOut ? ", timed out" : ""})`,
        { force: true }
      );
      return { backend, result, answer: answerOf(result) };
    })
  );

  const good = runs.filter((r) => r.result.status === 0 && !r.result.timedOut && r.answer);
  if (good.length === 0) {
    const detail = runs.map((r) => failureDetail(r.result, BACKENDS[r.backend].label)).join("; ");
    return { ok: false, rendered: renderFailure(meta, detail, runs[0]?.answer), meta, data: null };
  }

  let answer;
  const sections = [];
  if (good.length === 1) {
    answer = good[0].answer;
    const failed = runs.filter((r) => !good.includes(r));
    if (failed.length) {
      sections.push(
        `Note: ${failed.map((r) => `${BACKENDS[r.backend].label} (${failureDetail(r.result, BACKENDS[r.backend].label)})`).join(", ")} produced no answer; showing ${BACKENDS[good[0].backend].label} only.`,
        ""
      );
    }
  } else {
    const merger = mergerFor(request.via);
    reporter.phase(`comparing both answers (arbiter: ${BACKENDS[merger].label})`);
    const mergePrompt = interpolate(loadPrompt("advise-merge"), {
      REVIEWER: reviewerName(merger),
      REVIEWER_NAMES: good.map((r) => reviewerName(r.backend)).join(" and "),
      QUESTION: request.question,
      ANSWERS: good.map((r) => `### ${reviewerName(r.backend)}\n\n${r.answer}`).join("\n\n"),
    });
    const mergeModel = request.models[merger];
    const merged = await runModel({
      backend: merger,
      prompt: mergePrompt,
      cwd: repoRoot,
      model: mergeModel,
      effort: MERGE_EFFORT,
      withSchema: false,
      onProgress: reporter.forModel("arbiter"),
    });
    noteRun(merger, mergeModel, MERGE_EFFORT, "arbiter", merged);
    const mergedAnswer = answerOf(merged);
    if (merged.status === 0 && !merged.timedOut && mergedAnswer) {
      answer = mergedAnswer;
    } else {
      sections.push(`Note: the arbiter pass failed (${failureDetail(merged, BACKENDS[merger].label)}); both raw answers follow.`, "");
      answer = good.map((r) => `## ${reviewerName(r.backend)}\n\n${r.answer}`).join("\n\n");
    }
  }

  reporter.phase("rendering answer");
  const stamp = jobStampLine(meta);
  const lines = [
    `# ${meta.reviewerLabel} Advisory`,
    "",
    `Question: ${request.question}`,
    ...reviewerStampLines(meta),
    ...(stamp ? [stamp] : []),
    "",
    ...sections,
    answer,
    ...resumeLines(meta),
  ];
  if (meta.costUsd) lines.push(`Estimated cost: $${meta.costUsd.toFixed(2)} (Claude side only)`);
  return {
    ok: true,
    rendered: `${lines.join("\n").trimEnd()}\n`,
    meta,
    data: { verdict: null, summary: shorten(answer, 140), answer },
  };
}

async function runJob(dir, job, { interactive = false } = {}) {
  // A background job can be cancelled before its worker boots.
  if (readJob(dir, job.id)?.status === "cancelled") {
    appendLog(job.logFile, "job was cancelled before it started — not running");
    return { ok: false, rendered: `Job ${job.id} was cancelled before it started.\n`, data: null };
  }
  job.status = "running";
  job.pid = process.pid;
  job.progress = {
    phase: "starting",
    toolCalls: 0,
    lastActivity: null,
    lastActivityAt: nowIso(),
    startedAt: nowIso(),
  };
  writeJob(dir, job);
  const reporter = createReporter({ dir, job, interactive });
  const execute = job.kind === "advisory" ? executeAdvisory : executeReview;
  try {
    const outcome = await execute(job.request, { reporter, job });
    fs.writeFileSync(job.reportFile, outcome.rendered);
    if (outcome.data) {
      fs.writeFileSync(
        path.join(dir, `${job.id}.data.json`),
        JSON.stringify(outcome.data, null, 2)
      );
    }
    job.status = outcome.ok ? "completed" : "failed";
    job.verdict = outcome.data?.verdict ?? null;
    job.summary = outcome.data?.summary ? shorten(outcome.data.summary, 140) : null;
    job.sessions = outcome.meta.sessions;
    job.reviewers = outcome.meta.reviewers;
    job.costUsd = outcome.meta.costUsd || null;
    job.completedAt = nowIso();
    job.pid = null;
    job.progress = { ...job.progress, phase: "done" };
    if (readJob(dir, job.id)?.status === "cancelled") {
      appendLog(job.logFile, `job finished as ${job.status} but was already cancelled — keeping cancelled state`);
      return outcome;
    }
    writeJob(dir, job);
    reporter.line(`job ${job.id} ${job.status}`, { force: true });
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reporter.line(`error: ${message}`, { force: true });
    fs.writeFileSync(job.reportFile, `# cross-check ${job.kind === "advisory" ? "Advisory" : "Review"}\n\nRun failed: ${message}\n`);
    job.status = "failed";
    job.error = message;
    job.completedAt = nowIso();
    job.pid = null;
    writeJob(dir, job);
    return { ok: false, rendered: `Run failed: ${message}\n` };
  }
}

// ---------------------------------------------------------------------------
// subcommands

// Effort must be valid for every backend that will run. `max` is Claude-only.
function validateEffort(rawEffort, via) {
  const effort = String(rawEffort ?? DEFAULT_EFFORT).toLowerCase();
  const allowed = backendsFor(via).map((b) => BACKENDS[b].efforts);
  const ok = EFFORT_ORDER.includes(effort) && allowed.every((set) => set.has(effort));
  if (!ok) {
    const common = EFFORT_ORDER.filter((e) => allowed.every((set) => set.has(e)));
    fail(`Unsupported effort "${rawEffort}" for --via ${via}. Use one of: ${common.join(", ")}.`);
  }
  return effort;
}

// Resolves --via/--model into { via, models: { claude, codex } }. --model
// applies to the single selected backend; with --via both it is ambiguous.
function resolveRouting(options) {
  const via = resolveVia(options.via);
  const models = { claude: BACKENDS.claude.defaultModel, codex: BACKENDS.codex.defaultModel };
  if (options.model) {
    if (via === "both") fail("--model cannot be combined with --via both (which model would it apply to?). Use --via claude or --via codex.");
    models[via] = options.model;
  }
  return { via, models };
}

function buildReviewRequest(options, positionals) {
  const { via, models } = resolveRouting(options);
  return {
    cwd: options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd(),
    base: options.base ?? null,
    scope: options.scope ?? "auto",
    via,
    models,
    effort: validateEffort(options.effort, via),
    adversarial: Boolean(options.adversarial),
    deep: Boolean(options.deep),
    quiet: Boolean(options.quiet),
    focusText: positionals.join(" ").trim(),
  };
}

function createJob(dir, request, { kind, targetLabel }) {
  const id = newJobId();
  const job = {
    id,
    kind,
    status: "queued",
    title: `${reviewerLabel(request.via, request.models)} ${kind}`,
    targetLabel,
    createdAt: nowIso(),
    completedAt: null,
    pid: null,
    reportFile: path.join(dir, `${id}.md`),
    logFile: path.join(dir, `${id}.log`),
    request,
  };
  writeJob(dir, job);
  return job;
}

// Detaches a worker process for --background jobs and prints polling guidance.
function launchBackground(dir, repoRoot, job, options) {
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [scriptPath, "worker", "--repo", repoRoot, "--job", job.id], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  job.pid = child.pid ?? null;
  writeJob(dir, job);
  const payload = { jobId: job.id, status: "queued", title: job.title, target: job.targetLabel };
  process.stdout.write(
    options.json
      ? `${JSON.stringify(payload, null, 2)}\n`
      : [
          `${job.title} started in the background as ${job.id} (${job.targetLabel}).`,
          `Poll progress (live phase, tool activity, elapsed time): cross-check status ${job.id}  — every 30-60s is a good cadence.`,
          `Stream the activity log: tail -f ${job.logFile}`,
          `Get the report when done: cross-check result ${job.id}`,
          `It is still healthy as long as status shows recent activity; only treat it as stalled if status itself says so.`,
        ].join("\n") + "\n"
  );
}

async function handleReview(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueFlags: ["base", "scope", "model", "effort", "cwd", "via"],
    boolFlags: ["adversarial", "deep", "background", "json", "quiet", "dry-run"],
  });
  const request = buildReviewRequest(options, positionals);
  const routeLine = `via ${request.via} → ${reviewerLabel(request.via, request.models)} | effort ${request.effort}${request.deep ? " | deep mode: 3 lens passes per reviewer + merge" : ""}${request.via === "both" ? ` | arbiter ${BACKENDS[mergerFor(request.via)].label}` : ""}`;

  // Dry run: show what would be sent to the reviewer (target + assembled
  // prompt) without calling claude or creating a job. Free to run.
  if (options["dry-run"]) {
    const target = resolveReviewTarget(request.cwd, { base: request.base, scope: request.scope });
    const context = collectReviewContext(request.cwd, target);
    const prompt = buildReviewPrompt({
      adversarial: request.adversarial,
      context,
      focusText: request.focusText,
      lens: null,
      backend: backendsFor(request.via)[0],
    });
    process.stdout.write(
      [
        "# cross-check Review — dry run (no model call, no job created)",
        "",
        `Target: ${target.label}`,
        context.summary,
        `Diff ${context.inline ? "inlined" : "too large — reviewer would self-collect"} | prompt ${Buffer.byteLength(prompt)} bytes | ${routeLine}`,
        "",
        "--- assembled prompt below ---",
        "",
        prompt,
      ].join("\n")
    );
    return;
  }

  ensureBackendsAvailable(request.via);
  const repoRoot = ensureGitRepository(request.cwd);
  const target = resolveReviewTarget(request.cwd, { base: request.base, scope: request.scope });
  const dir = jobsDir(repoRoot);
  const kind = request.deep ? "deep-review" : request.adversarial ? "adversarial-review" : "review";
  const job = createJob(dir, request, { kind, targetLabel: target.label });

  if (options.background) {
    launchBackground(dir, repoRoot, job, options);
    return;
  }

  if (!request.quiet) process.stderr.write(`[cross-check] ${routeLine}\n`);
  const outcome = await runJob(dir, job, { interactive: true });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ job: readJob(dir, job.id), result: outcome.data ?? null }, null, 2)}\n`);
  } else {
    process.stdout.write(outcome.rendered);
    process.stdout.write(`\nReport saved: ${job.reportFile}\n`);
  }
  if (!outcome.ok) process.exitCode = 1;
}

async function handleAsk(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueFlags: ["model", "effort", "cwd", "via"],
    boolFlags: ["background", "json", "quiet", "dry-run"],
  });
  const question = positionals.join(" ").trim();
  if (!question) {
    fail('ask requires a question, e.g. `cross-check.mjs ask "should the job runner use worker threads?"`');
  }
  const { via, models } = resolveRouting(options);
  const request = {
    cwd: options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd(),
    via,
    models,
    effort: validateEffort(options.effort, via),
    quiet: Boolean(options.quiet),
    question,
  };
  const routeLine = `via ${via} → ${reviewerLabel(via, models)} | effort ${request.effort}${via === "both" ? ` | arbiter ${BACKENDS[mergerFor(via)].label}` : ""}`;

  if (options["dry-run"]) {
    const dryRoot = ensureGitRepository(request.cwd);
    const { prompt } = buildAdvisoryPrompt(dryRoot, request.question, backendsFor(via)[0]);
    process.stdout.write(
      [
        "# cross-check Advisory — dry run (no model call, no job created)",
        "",
        `Question: ${request.question}`,
        `Prompt ${Buffer.byteLength(prompt)} bytes | ${routeLine}`,
        "",
        "--- assembled prompt below ---",
        "",
        prompt,
      ].join("\n")
    );
    return;
  }

  ensureBackendsAvailable(via);
  const repoRoot = ensureGitRepository(request.cwd);
  const dir = jobsDir(repoRoot);
  const job = createJob(dir, request, {
    kind: "advisory",
    targetLabel: shorten(question, 80),
  });

  if (options.background) {
    launchBackground(dir, repoRoot, job, options);
    return;
  }

  if (!request.quiet) process.stderr.write(`[cross-check] ${routeLine}\n`);
  const outcome = await runJob(dir, job, { interactive: true });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ job: readJob(dir, job.id), result: outcome.data ?? null }, null, 2)}\n`);
  } else {
    process.stdout.write(outcome.rendered);
    process.stdout.write(`\nAnswer saved: ${job.reportFile}\n`);
  }
  if (!outcome.ok) process.exitCode = 1;
}

async function handleWorker(argv) {
  const { options } = parseArgs(argv, { valueFlags: ["repo", "job"] });
  if (!options.repo || !options.job) fail("worker requires --repo and --job.");
  const dir = jobsDir(options.repo);
  const job = readJob(dir, options.job);
  if (!job) fail(`No job ${options.job} found for this repository.`);
  await runJob(dir, job);
}

function describeJob(job) {
  const status = effectiveStatus(job);
  const lines = [`- ${job.id} | ${status} | ${job.kind} | ${job.targetLabel}`];
  if (job.summary) lines.push(`  Summary: ${job.summary}`);
  if (job.verdict) lines.push(`  Verdict: ${job.verdict}`);
  if (status === "running" && job.progress) {
    const elapsedMs = Date.now() - Date.parse(job.progress.startedAt ?? job.createdAt);
    lines.push(
      `  Elapsed: ${formatElapsed(elapsedMs)} | Phase: ${job.progress.phase ?? "unknown"} | Tool calls: ${job.progress.toolCalls ?? 0}`
    );
    if (job.progress.lastActivity) {
      const ageMs = Date.now() - Date.parse(job.progress.lastActivityAt ?? job.createdAt);
      lines.push(`  Last activity (${formatElapsed(ageMs)} ago): ${job.progress.lastActivity}`);
      // Stall detection keys off the model's last proof of life (any stream
      // event, incl. thinking ticks) — wrapper heartbeats don't count.
      const eventAgeMs =
        Date.now() - Date.parse(job.progress.lastEventAt ?? job.progress.lastActivityAt ?? job.createdAt);
      lines.push(
        eventAgeMs > STALL_WARN_MS
          ? `  WARNING: no model events for ${formatElapsed(eventAgeMs)} — possibly stalled. Consider \`cross-check cancel ${job.id}\` and rerunning.`
          : `  Healthy: activity is recent. Long runs are normal — poll again in 30-60s.`
      );
    }
  }
  if (job.status === "completed" || job.status === "failed") {
    lines.push(`  Report: cross-check result ${job.id}`);
  }
  if (job.status === "running" || job.status === "queued") {
    lines.push(`  Cancel: cross-check cancel ${job.id}`);
    lines.push(`  Log: ${job.logFile}`);
  }
  return lines.join("\n");
}

function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueFlags: ["cwd"],
    boolFlags: ["json"],
  });
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const repoRoot = ensureGitRepository(cwd);
  const dir = jobsDir(repoRoot);

  if (positionals[0]) {
    const job = reconcileDeadJob(dir, readJob(dir, positionals[0]));
    if (!job) fail(`No job ${positionals[0]} found for this repository.`);
    process.stdout.write(
      options.json ? `${JSON.stringify(job, null, 2)}\n` : `# Fable Job Status\n\n${describeJob(job)}\n`
    );
    return;
  }

  const jobs = listJobs(dir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(jobs, null, 2)}\n`);
    return;
  }
  if (jobs.length === 0) {
    process.stdout.write("No cross-check jobs recorded for this repository yet.\n");
    return;
  }
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued");
  const recent = jobs.filter((j) => !(j.status === "running" || j.status === "queued")).slice(0, 5);
  const lines = ["# Fable Status", ""];
  if (active.length) {
    lines.push("Active:");
    for (const job of active) lines.push(describeJob(job));
    lines.push("");
  }
  if (recent.length) {
    lines.push("Recent:");
    for (const job of recent) lines.push(describeJob(job));
  }
  process.stdout.write(`${lines.join("\n").trimEnd()}\n`);
}

function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueFlags: ["cwd"],
    boolFlags: ["json"],
  });
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const repoRoot = ensureGitRepository(cwd);
  const dir = jobsDir(repoRoot);

  let job;
  if (positionals[0]) {
    job = reconcileDeadJob(dir, readJob(dir, positionals[0]));
    if (!job) fail(`No job ${positionals[0]} found for this repository.`);
  } else {
    // Without an explicit id, an active job means "the report you want isn't
    // ready yet" — serving the previous run's report here would be silently
    // wrong, which is worse than an error.
    const jobs = listJobs(dir);
    const active = jobs.find((j) => j.status === "running" || j.status === "queued");
    if (active) {
      const ageMs = Date.now() - Date.parse(active.progress?.startedAt ?? active.createdAt);
      const finished = jobs.find((j) => j.status === "completed" || j.status === "failed");
      fail(
        [
          `Job ${active.id} is still ${active.status} (started ${formatElapsed(ageMs)} ago) — no result yet.`,
          `Poll it with: cross-check status ${active.id} — or if it's stuck, clear it with: cross-check cancel ${active.id}`,
          finished
            ? `The latest finished report is ${finished.id} from ${finished.completedAt ?? finished.createdAt}; pass its id explicitly if you really want that one: cross-check result ${finished.id}`
            : null,
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    job = jobs.find((j) => j.status === "completed" || j.status === "failed");
    if (!job) fail("No finished cross-check job found for this repository.");
  }

  if (job.status === "running" || job.status === "queued") {
    fail(`Job ${job.id} is still ${job.status}. Check \`cross-check status ${job.id}\`.`);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
    return;
  }
  let report = "";
  try {
    report = fs.readFileSync(job.reportFile, "utf8");
  } catch {
    report = `No stored report for ${job.id}.\n`;
  }
  process.stdout.write(report.endsWith("\n") ? report : `${report}\n`);
}

function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueFlags: ["cwd"],
    boolFlags: ["json"],
  });
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const repoRoot = ensureGitRepository(cwd);
  const dir = jobsDir(repoRoot);

  let job;
  if (positionals[0]) {
    job = reconcileDeadJob(dir, readJob(dir, positionals[0]));
  } else {
    job = listJobs(dir).find((j) => j.status === "running" || j.status === "queued");
  }
  if (!job) fail("No active cross-check job to cancel.");
  if (job.status !== "running" && job.status !== "queued") {
    fail(`Job ${job.id} is already ${job.status}.`);
  }

  if (job.pid && isAlive(job.pid)) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  // The worker may have finished between our read and the kill — don't
  // overwrite a completed/failed job with a stale cancellation.
  const current = readJob(dir, job.id) ?? job;
  if (current.status === "completed" || current.status === "failed") {
    process.stdout.write(
      options.json
        ? `${JSON.stringify(current, null, 2)}\n`
        : `Job ${current.id} already finished as ${current.status} — nothing to cancel. Report: cross-check result ${current.id}\n`
    );
    return;
  }
  current.status = "cancelled";
  current.completedAt = nowIso();
  current.pid = null;
  writeJob(dir, current);
  appendLog(current.logFile, "Cancelled by user.");
  process.stdout.write(
    options.json ? `${JSON.stringify(current, null, 2)}\n` : `Cancelled ${current.id} (${current.kind}).\n`
  );
}

function ensureClaudeAvailable() {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      "The `claude` CLI is not installed or not on PATH. Install Claude Code (https://claude.com/claude-code), then run `cross-check setup`."
    );
  }
  return result.stdout.trim();
}

function ensureCodexAvailable() {
  const result = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      "The `codex` CLI is not installed or not on PATH. Install Codex (`npm i -g @openai/codex`), then run `cross-check setup`."
    );
  }
  return result.stdout.trim();
}

function ensureBackendsAvailable(via) {
  for (const b of backendsFor(via)) BACKENDS[b].ensure();
}

function handleSetup(argv) {
  const { options } = parseArgs(argv, { boolFlags: ["json"] });
  const checks = [];
  const nextSteps = [];

  checks.push({ name: "node", ok: true, detail: process.version });

  const cliChecks = [
    { backend: "claude", install: "Install Claude Code: https://claude.com/claude-code", login: "Log in to Claude: run `claude` once and complete login.", auth: ["auth", "status"] },
    { backend: "codex", install: "Install Codex: npm i -g @openai/codex", login: "Log in to Codex: run `codex login`.", auth: ["login", "status"] },
  ];
  for (const c of cliChecks) {
    let ok = false;
    let detail = "";
    try {
      detail = BACKENDS[c.backend].ensure();
      ok = true;
    } catch (error) {
      detail = error.message;
      nextSteps.push(c.install);
    }
    checks.push({ name: `${c.backend} CLI`, ok, detail });
    if (!ok) continue;
    const auth = spawnSync(c.backend, c.auth, { encoding: "utf8" });
    const authOut = `${auth.stdout ?? ""}${auth.stderr ?? ""}`.trim();
    const authOk = auth.status === 0;
    checks.push({ name: `${c.backend} auth`, ok: authOk, detail: shorten(authOut || "(no output)", 200) });
    if (!authOk) nextSteps.push(c.login);
  }
  const caller = detectCaller();
  checks.push({
    name: "routing",
    ok: true,
    detail: `caller=${caller ?? "none (plain terminal)"} → default reviewer ${BACKENDS[resolveVia(null)].label}; override with --via claude|codex|both`,
  });

  const gitResult = spawnSync("git", ["--version"], { encoding: "utf8" });
  const gitOk = !gitResult.error && gitResult.status === 0;
  checks.push({ name: "git", ok: gitOk, detail: gitOk ? gitResult.stdout.trim() : "not found" });
  if (!gitOk) nextSteps.push("Install Git.");

  try {
    fs.mkdirSync(STATE_ROOT, { recursive: true });
    checks.push({ name: "state dir", ok: true, detail: STATE_ROOT });
  } catch (error) {
    checks.push({ name: "state dir", ok: false, detail: String(error) });
  }

  const ready = checks.every((c) => c.ok);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ready, checks, nextSteps }, null, 2)}\n`);
    return;
  }
  const lines = ["# cross-check Setup", "", `Status: ${ready ? "ready" : "needs attention"}`, "", "Checks:"];
  for (const check of checks) lines.push(`- ${check.ok ? "ok" : "MISSING"} ${check.name}: ${check.detail}`);
  if (nextSteps.length) {
    lines.push("", "Next steps:");
    for (const step of nextSteps) lines.push(`- ${step}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  if (!ready) process.exitCode = 1;
}

function printUsage() {
  process.stdout.write(
    [
      "cross-check — extensive code review and advisory by the other vendor's model",
      "",
      "Usage:",
      "  cross-check.mjs setup [--json]",
      "  cross-check.mjs review [--via claude|codex|both] [--effort low|medium|high|xhigh]",
      "                         [--adversarial] [--deep] [--base <ref>] [--scope auto|working-tree|branch]",
      "                         [--model <model>] [--background] [--json] [--quiet] [--dry-run] [focus text]",
      "  cross-check.mjs ask    [--via ...] [--effort ...] [--model ...] [--background] [--json] [--quiet] [--dry-run] <question>",
      "  cross-check.mjs status [job-id] [--json]",
      "  cross-check.mjs result [job-id] [--json]",
      "  cross-check.mjs cancel [job-id] [--json]",
      "",
      "Routing: --via wins. Otherwise a Claude Code caller gets Codex (Astra), a Codex caller gets Claude (Fable),",
      "and a plain terminal gets Codex. `both` runs both and an arbiter (the caller's opposite) merges them,",
      "listing where they disagree.",
      "Effort default: medium. `max` is Claude-only.",
      "Reviews are read-only. Focus text steers the review (most useful with --adversarial).",
      "--deep runs three parallel lens passes (correctness, security, design) per reviewer plus a merge pass.",
      "`ask` answers an advisory question (architecture, tradeoffs, second opinions) with read-only repo access.",
      "Progress streams to stderr while running (tool calls + heartbeats every ~20s); --quiet suppresses it.",
      "--dry-run prints the resolved target, routing and assembled prompt without calling any model (free).",
      "Background jobs expose live progress via `status` (phase, elapsed, last activity).",
      "",
    ].join("\n")
  );
}

async function main() {
  const [subcommand, ...rest] = normalizeArgv(process.argv.slice(2));
  const argv = normalizeArgv(rest);
  switch (subcommand) {
    case "setup":
      handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "ask":
      await handleAsk(argv);
      break;
    case "worker":
      await handleWorker(argv);
      break;
    case "status":
      handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    case undefined:
    case "help":
    case "--help":
      printUsage();
      break;
    default:
      fail(`Unknown subcommand: ${subcommand}. Run \`cross-check.mjs help\` for usage.`);
  }
}

// Run the CLI only when executed directly; importing this file (tests) must
// not trigger main(). realpath both sides so the skill-dir symlink still counts.
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

export {
  BACKENDS,
  executeReview,
  detectCaller,
  resolveVia,
  backendsFor,
  mergerFor,
  reviewerLabel,
  validateEffort,
  codexEventReducer,
  codexEffort,
  splitRawArgumentString,
  normalizeArgv,
  parseArgs,
  shorten,
  formatElapsed,
  resolveReviewTarget,
  collectReviewContext,
  extractStructured,
  normalizeReviewData,
  jobStampLine,
  renderReport,
  jobsDir,
  writeJob,
  readJob,
  listJobs,
  reconcileDeadJob,
  effectiveStatus,
};
