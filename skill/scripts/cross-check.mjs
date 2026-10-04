#!/usr/bin/env node
// cross-check — extensive code review powered by Claude Fable 5.
// Runs the local `claude` CLI headlessly with read-only tools; auth rides on the
// user's existing Claude Code login. Portions of the prompt/schema design are
// adapted from openai/codex-plugin-cc (Apache-2.0) — see NOTICE.

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

const DEFAULT_MODEL = "claude-fable-5";
const DEFAULT_EFFORT = "xhigh";
const MERGE_EFFORT = "high";
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MAX_INLINE_DIFF_BYTES = 400 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 48 * 1024;
const CLAUDE_TIMEOUT_MS = 45 * 60 * 1000;
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

function buildReviewPrompt({ adversarial, context, focusText, lens }) {
  const template = loadPrompt(adversarial ? "adversarial-review" : "review");
  return interpolate(template, {
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
const ACTIVE_CLAUDE_CHILDREN = new Set();

function killActiveClaudeChildren() {
  for (const child of ACTIVE_CLAUDE_CHILDREN) {
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
      killActiveClaudeChildren();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

// Runs the claude CLI with stream-json output so progress is observable while
// the model works. The final "result" event carries the same envelope fields
// as --output-format json (result, structured_output, session_id, cost).
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
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    // Agentic -p runs don't reliably enforce --json-schema, so the schema also
    // goes into the prompt verbatim — exact field names, exact enums.
    fullPrompt = `${prompt}\n\n<output_schema>\nYour final message must be exactly one JSON object conforming to this JSON Schema — no markdown fences, no prose before or after, no extra or renamed fields:\n${schema}\n</output_schema>\n`;
    args.push("--json-schema", schema);
  }

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    ACTIVE_CLAUDE_CHILDREN.add(child);
    let stderr = "";
    let lineBuffer = "";
    let rawStdout = "";
    let envelope = null;
    let timedOut = false;
    let toolCalls = 0;
    let lastNote = "starting up";
    let lastEmitAt = Date.now();

    const emit = (text, kind = "info", eventAgeMs = 0) => {
      lastEmitAt = Date.now();
      onProgress?.(text, { kind, toolCalls, eventAgeMs });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, CLAUDE_TIMEOUT_MS);

    // Long thinking stretches produce no events; the heartbeat keeps callers
    // (and watching agents) from mistaking that for a stall.
    let lastEventAtMs = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastEmitAt < Math.max(0, HEARTBEAT_MS - 2000)) return;
      const eventAgeMs = Date.now() - lastEventAtMs;
      const idleNote = eventAgeMs > 60_000 ? ` (no model events for ${formatElapsed(eventAgeMs)})` : "";
      emit(
        `still working — ${formatElapsed(Date.now() - started)} elapsed, ${toolCalls} tool call(s) so far, last: ${lastNote}${idleNote}`,
        "heartbeat",
        eventAgeMs
      );
    }, HEARTBEAT_MS);

    const handleEvent = (event) => {
      // Any event from the claude process counts as proof of life — including
      // thinking-token ticks, which are the only events during long reasoning.
      lastEventAtMs = Date.now();
      if (event.type === "system" && event.subtype === "thinking_tokens") {
        if (event.estimated_tokens) lastNote = `thinking (~${event.estimated_tokens} tokens)`;
        return;
      }
      if (event.type === "system" && event.subtype === "init") {
        emit(`session started (model=${model}, effort=${effort})`);
        return;
      }
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "tool_use") {
            toolCalls += 1;
            lastNote = summarizeToolUse(block.name, block.input, cwd);
            emit(`tool #${toolCalls}: ${lastNote}`, "tool");
          }
        }
        return;
      }
      if (event.type === "result") {
        envelope = event;
      }
    };

    const consume = (text) => {
      lineBuffer += text;
      let newline;
      while ((newline = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // non-JSON noise on stdout; ignore
        }
      }
    };

    const finish = (status, extraStderr = "") => {
      ACTIVE_CLAUDE_CHILDREN.delete(child);
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (lineBuffer.trim()) consume("\n");
      resolve({
        status,
        stdout: rawStdout,
        stderr: extraStderr ? `${stderr}\n${extraStderr}` : stderr,
        durationMs: Date.now() - started,
        timedOut,
        toolCalls,
        envelope,
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

    child.stdin.write(fullPrompt);
    child.stdin.end();
    emit(`claude started (model=${model}, effort=${effort}, pid=${child.pid})`);
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

function renderReport(data, meta) {
  const stamp = jobStampLine(meta);
  const lines = [
    `# Fable ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ...(stamp ? [stamp] : []),
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    "",
  ];

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

  if (meta.sessionIds?.length) {
    lines.push("", `Resume interactively: claude -r ${meta.sessionIds[meta.sessionIds.length - 1]}`);
  }
  if (meta.costUsd != null) {
    lines.push(`Estimated cost: $${meta.costUsd.toFixed(2)}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderFailure(meta, detail, rawText) {
  const stamp = jobStampLine(meta);
  const lines = [
    `# Fable ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
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
      appendLog(job.logFile, "cancellation detected — stopping claude and exiting");
      if (interactive && !job.request?.quiet) {
        process.stderr.write("[cross-check] cancellation detected — stopping\n");
      }
      killActiveClaudeChildren();
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
    forClaude(label) {
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
  const meta = {
    reviewLabel,
    targetLabel: target.label,
    jobId: job?.id ?? null,
    createdAt: job?.createdAt ?? null,
    sessionIds: [],
    costUsd: 0,
  };

  const runPass = async (lens, effortOverride) => {
    const prompt = buildReviewPrompt({
      adversarial: request.adversarial,
      context,
      focusText: request.focusText,
      lens,
    });
    const result = await runClaude({
      prompt,
      cwd: context.repoRoot,
      model: request.model,
      effort: effortOverride ?? request.effort,
      onProgress: reporter.forClaude(lens?.key),
    });
    if (result.envelope?.session_id) meta.sessionIds.push(result.envelope.session_id);
    if (typeof result.envelope?.total_cost_usd === "number") {
      meta.costUsd += result.envelope.total_cost_usd;
    }
    reporter.line(
      `pass${lens ? ` [${lens.key}]` : ""} finished in ${formatElapsed(result.durationMs)} (exit ${result.status}${result.timedOut ? ", timed out" : ""})`,
      { force: true }
    );
    return result;
  };

  let finalResult;
  if (request.deep) {
    reporter.phase(`running ${LENSES.length} lens passes in parallel (correctness, security, design)`);
    let lensesDone = 0;
    const passes = await Promise.all(
      LENSES.map((lens) =>
        runPass(lens).then((result) => {
          lensesDone += 1;
          reporter.phase(`lens passes: ${lensesDone}/${LENSES.length} complete`);
          return result;
        })
      )
    );
    const passPayloads = passes.map((p, i) => ({
      lens: LENSES[i].key,
      ok: p.status === 0,
      result: extractStructured(p.envelope),
      error: p.status === 0 ? null : shorten(p.stderr || "claude exited non-zero", 400),
    }));
    const usable = passPayloads.filter((p) => p.result);
    if (usable.length === 0) {
      const detail = passPayloads.map((p) => `${p.lens}: ${p.error ?? "no structured output"}`).join("; ");
      return { ok: false, rendered: renderFailure(meta, detail, passes[0]?.envelope?.result), meta };
    }
    reporter.phase(`merging ${usable.length}/${LENSES.length} lens passes into one report`);
    const mergePrompt = interpolate(loadPrompt("merge"), {
      PASS_COUNT: String(usable.length),
      TARGET_LABEL: target.label,
      PASS_RESULTS: usable
        .map((p) => `### Lens: ${p.lens}\n\`\`\`json\n${JSON.stringify(p.result, null, 2)}\n\`\`\``)
        .join("\n\n"),
      REVIEW_INPUT: context.content,
    });
    finalResult = await runClaude({
      prompt: mergePrompt,
      cwd: context.repoRoot,
      model: request.model,
      effort: MERGE_EFFORT,
      onProgress: reporter.forClaude("merge"),
    });
    if (finalResult.envelope?.session_id) meta.sessionIds.push(finalResult.envelope.session_id);
    if (typeof finalResult.envelope?.total_cost_usd === "number") {
      meta.costUsd += finalResult.envelope.total_cost_usd;
    }
  } else {
    reporter.phase("review pass running (reading code, tracing data flow, verifying findings)");
    finalResult = await runPass(null);
  }
  reporter.phase("rendering report");

  const raw = extractStructured(finalResult.envelope);
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
        ? shorten(finalResult.stderr || "claude exited non-zero", 600)
        : "output did not match the review schema";
    return {
      ok: false,
      rendered: renderFailure(meta, detail, finalResult.envelope?.result ?? finalResult.stdout),
      meta,
      data: null,
    };
  }

  return { ok: true, rendered: renderReport(data, meta), meta, data };
}

function buildAdvisoryPrompt(repoRoot, question) {
  const branch = getCurrentBranch(repoRoot);
  const gitStatus = gitChecked(repoRoot, ["status", "--short"]).trim() || "(clean)";
  let recentCommits = "(no commits yet)";
  try {
    recentCommits = gitChecked(repoRoot, ["log", "--oneline", "-15"]).trim() || recentCommits;
  } catch {
    // empty repo; keep the placeholder
  }
  const prompt = interpolate(loadPrompt("advise"), {
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
  const { prompt, branch } = buildAdvisoryPrompt(repoRoot, request.question);

  const meta = {
    reviewLabel: "Advisory",
    targetLabel: `question on ${branch}`,
    jobId: job?.id ?? null,
    createdAt: job?.createdAt ?? null,
    sessionIds: [],
    costUsd: 0,
  };
  reporter.phase("advisor exploring the repository and forming an answer");
  reporter.line("expect roughly 1-6 minutes depending on the question; progress lines stream continuously");
  const result = await runClaude({
    prompt,
    cwd: repoRoot,
    model: request.model,
    effort: request.effort,
    withSchema: false,
    onProgress: reporter.forClaude(null),
  });
  if (result.envelope?.session_id) meta.sessionIds.push(result.envelope.session_id);
  if (typeof result.envelope?.total_cost_usd === "number") {
    meta.costUsd += result.envelope.total_cost_usd;
  }
  reporter.line(
    `advisor finished in ${formatElapsed(result.durationMs)} (exit ${result.status}${result.timedOut ? ", timed out" : ""})`,
    { force: true }
  );

  const answer = typeof result.envelope?.result === "string" ? result.envelope.result.trim() : "";
  if (result.status !== 0 || result.timedOut || !answer) {
    const detail = result.timedOut
      ? "advisory run timed out"
      : result.status !== 0
        ? shorten(result.stderr || "claude exited non-zero", 600)
        : "the advisor returned no answer text";
    return { ok: false, rendered: renderFailure(meta, detail, answer), meta, data: null };
  }

  reporter.phase("rendering answer");
  const stamp = jobStampLine(meta);
  const lines = [
    "# Fable Advisory",
    "",
    `Question: ${request.question}`,
    ...(stamp ? [stamp] : []),
    "",
    answer,
  ];
  if (meta.sessionIds.length) {
    lines.push("", `Resume interactively: claude -r ${meta.sessionIds[meta.sessionIds.length - 1]}`);
  }
  if (meta.costUsd) lines.push(`Estimated cost: $${meta.costUsd.toFixed(2)}`);
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
    job.sessionIds = outcome.meta.sessionIds;
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
    fs.writeFileSync(job.reportFile, `# Fable ${job.kind === "advisory" ? "Advisory" : "Review"}\n\nRun failed: ${message}\n`);
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

function validateEffort(rawEffort) {
  const effort = (rawEffort ?? DEFAULT_EFFORT).toLowerCase();
  if (!VALID_EFFORTS.has(effort)) {
    fail(`Unsupported effort "${rawEffort}". Use one of: low, medium, high, xhigh, max.`);
  }
  return effort;
}

function buildReviewRequest(options, positionals) {
  return {
    cwd: options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd(),
    base: options.base ?? null,
    scope: options.scope ?? "auto",
    model: options.model ?? DEFAULT_MODEL,
    effort: validateEffort(options.effort),
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
    title: `Fable ${kind}`,
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
    valueFlags: ["base", "scope", "model", "effort", "cwd"],
    boolFlags: ["adversarial", "deep", "background", "json", "quiet", "dry-run"],
  });
  const request = buildReviewRequest(options, positionals);

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
    });
    process.stdout.write(
      [
        "# Fable Review — dry run (no claude call, no job created)",
        "",
        `Target: ${target.label}`,
        context.summary,
        `Diff ${context.inline ? "inlined" : "too large — reviewer would self-collect"} | prompt ${Buffer.byteLength(prompt)} bytes | model ${request.model} | effort ${request.effort}${request.deep ? " | deep mode would run 3 lens passes + merge" : ""}`,
        "",
        "--- assembled prompt below ---",
        "",
        prompt,
      ].join("\n")
    );
    return;
  }

  ensureClaudeAvailable();
  const repoRoot = ensureGitRepository(request.cwd);
  const target = resolveReviewTarget(request.cwd, { base: request.base, scope: request.scope });
  const dir = jobsDir(repoRoot);
  const kind = request.deep ? "deep-review" : request.adversarial ? "adversarial-review" : "review";
  const job = createJob(dir, request, { kind, targetLabel: target.label });

  if (options.background) {
    launchBackground(dir, repoRoot, job, options);
    return;
  }

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
    valueFlags: ["model", "effort", "cwd"],
    boolFlags: ["background", "json", "quiet", "dry-run"],
  });
  const question = positionals.join(" ").trim();
  if (!question) {
    fail('ask requires a question, e.g. `cross-check.mjs ask "should the job runner use worker threads?"`');
  }
  const request = {
    cwd: options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd(),
    model: options.model ?? DEFAULT_MODEL,
    effort: validateEffort(options.effort),
    quiet: Boolean(options.quiet),
    question,
  };

  if (options["dry-run"]) {
    const dryRoot = ensureGitRepository(request.cwd);
    const { prompt } = buildAdvisoryPrompt(dryRoot, request.question);
    process.stdout.write(
      [
        "# Fable Advisory — dry run (no claude call, no job created)",
        "",
        `Question: ${request.question}`,
        `Prompt ${Buffer.byteLength(prompt)} bytes | model ${request.model} | effort ${request.effort}`,
        "",
        "--- assembled prompt below ---",
        "",
        prompt,
      ].join("\n")
    );
    return;
  }

  ensureClaudeAvailable();
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

function handleSetup(argv) {
  const { options } = parseArgs(argv, { boolFlags: ["json"] });
  const checks = [];
  const nextSteps = [];

  checks.push({ name: "node", ok: true, detail: process.version });

  let claudeOk = false;
  let claudeDetail = "";
  try {
    claudeDetail = ensureClaudeAvailable();
    claudeOk = true;
  } catch (error) {
    claudeDetail = error.message;
    nextSteps.push("Install Claude Code: https://claude.com/claude-code");
  }
  checks.push({ name: "claude CLI", ok: claudeOk, detail: claudeDetail });

  if (claudeOk) {
    const auth = spawnSync("claude", ["auth", "status"], { encoding: "utf8" });
    const authOut = `${auth.stdout ?? ""}${auth.stderr ?? ""}`.trim();
    const authOk = auth.status === 0;
    checks.push({ name: "claude auth", ok: authOk, detail: shorten(authOut || "(no output)", 200) });
    if (!authOk) nextSteps.push("Log in to Claude: run `claude` once and complete login.");
  }

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
  const lines = ["# Fable Check Setup", "", `Status: ${ready ? "ready" : "needs attention"}`, "", "Checks:"];
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
      "cross-check — extensive code review and advisory powered by Claude Fable 5",
      "",
      "Usage:",
      "  cross-check.mjs setup [--json]",
      "  cross-check.mjs review [--adversarial] [--deep] [--base <ref>] [--scope auto|working-tree|branch]",
      "                         [--effort low|medium|high|xhigh|max] [--model <model>]",
      "                         [--background] [--json] [--quiet] [--dry-run] [focus text]",
      "  cross-check.mjs ask    [--effort ...] [--model ...] [--background] [--json] [--quiet] [--dry-run] <question>",
      "  cross-check.mjs status [job-id] [--json]",
      "  cross-check.mjs result [job-id] [--json]",
      "  cross-check.mjs cancel [job-id] [--json]",
      "",
      "Reviews are read-only. Focus text steers the review (most useful with --adversarial).",
      "--deep runs three parallel lens passes (correctness, security, design) plus a merge pass.",
      "`ask` answers an advisory question (architecture, tradeoffs, second opinions) with read-only repo access.",
      "Progress streams to stderr while running (tool calls + heartbeats every ~20s); --quiet suppresses it.",
      "--dry-run prints the resolved target and assembled prompt without calling claude (free).",
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
