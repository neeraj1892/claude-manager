'use strict';
const { createServer } = require('http');
const { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync, unlinkSync, createWriteStream, appendFileSync } = require('fs');
const { join, resolve, dirname, basename } = require('path');
const { homedir, platform } = require('os');
const { execSync, exec, spawn } = require('child_process');
const https = require('https');
const { tmpdir } = require('os');
const path = require('path');

// Auto-install express if needed
if (!existsSync(join(__dirname, 'node_modules', 'express'))) {
  console.log('Installing dependencies...');
  execSync('npm install', { cwd: __dirname, stdio: 'inherit', shell: true });
}

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// --- Config persistence ---
// GUARD RAIL: secrets (the OpenRouter API key) are NEVER written into the
// repo directory. They live in ~/.claude-manager.secrets.json (chmod 600),
// physically outside anything git could commit. claude-manager.config.json
// stays in the repo (and gitignored) for non-secret preferences only.
const CONFIG_PATH  = join(__dirname, 'claude-manager.config.json');
const SECRETS_PATH = join(homedir(), '.claude-manager.secrets.json');
const SECRET_KEYS  = ['openRouterKey'];

function loadSecrets() {
  try { return JSON.parse(readFileSync(SECRETS_PATH, 'utf8')); } catch { return {}; }
}

function saveSecrets(secrets) {
  try {
    writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  } catch {}
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  // One-time migration: a key found inside the repo config is moved out
  // immediately so it can never be committed.
  const leaked = SECRET_KEYS.filter(k => cfg[k]);
  if (leaked.length) {
    const secrets = loadSecrets();
    leaked.forEach(k => { if (!secrets[k]) secrets[k] = cfg[k]; delete cfg[k]; });
    saveSecrets(secrets);
    try { writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
    console.warn('⚠ Moved API key out of claude-manager.config.json into ~/.claude-manager.secrets.json (never committed).');
  }
  return { ...cfg, ...loadSecrets() };
}

function saveConfig(data) {
  const plain = { ...data };
  const secrets = loadSecrets();
  let secretsTouched = false;
  for (const k of SECRET_KEYS) {
    if (k in plain) {
      if (plain[k]) { secrets[k] = plain[k]; secretsTouched = true; }
      else if (plain[k] === '') { delete secrets[k]; secretsTouched = true; } // explicit clear
      delete plain[k]; // never in the repo file
    }
  }
  if (secretsTouched) saveSecrets(secrets);
  try { writeFileSync(CONFIG_PATH, JSON.stringify(plain, null, 2)); } catch {}
}

// Priority: CLI arg > CLAUDE_DIR env var > saved config > default ~/.claude
function expandHome(p) { return p.replace(/^~(?=[/\\]|$)/, homedir()); }
const cfg = loadConfig();
const initialPath = process.argv[2] || process.env.CLAUDE_DIR || cfg.claudeDir || join(homedir(), '.claude');
let claudeDir = resolve(expandHome(initialPath));

// GUARD RAIL: if the config file ever ends up tracked by git, say so loudly.
try {
  execSync('git ls-files --error-unmatch claude-manager.config.json', { cwd: __dirname, stdio: 'pipe', shell: true });
  console.warn('\n⚠⚠ claude-manager.config.json is TRACKED BY GIT. It must never be committed.');
  console.warn('   Fix: git rm --cached claude-manager.config.json  (and ensure it is in .gitignore)\n');
} catch {}

// --- Claude CLI availability check ---
let claudeCliAvailable = false;
try {
  execSync('claude --version', { shell: true, stdio: 'pipe', timeout: 5000 });
  claudeCliAvailable = true;
} catch {}

// --- Skill generation system prompt ---
// --- Generation system prompts ---
// Design laws applied: Pareto (vital few fields deliver 80% value), Occam (minimal fields),
// Humphrey (concrete example = spec), Kidlin (write it precisely), Miller (3-7 steps max)

const SKILL_SYSTEM_PROMPT = `You are an expert Claude Code skill author.

A SKILL.md teaches Claude a repeatable workflow. Claude reads it on invocation and follows
the steps exactly — clarity beats cleverness. One skill, one responsibility.

FRONTMATTER (use only what the skill needs — Occam):
  name:        kebab-case, no spaces. Becomes /name slash command.
  description: One or two sentences. What it does and what it produces.
  when_to_use: CRITICAL — list exact phrases a real user would type to trigger this skill.
               Vague triggers = missed activations. Specific triggers = reliable invocation.
  argument-hint: (if skill takes an arg) Short placeholder, e.g. "[filename]" or "[PR number]"
  allowed-tools: ALWAYS set this when the steps use tools — derive it from the steps you
               write, even when the user never mentioned permissions. Pre-approves them so
               the skill runs WITHOUT permission prompts for that turn. Space/comma rules:
               allowed-tools: Read Grep Bash(git add *) Bash(git commit *)
               Grant only what the steps actually need — never a blanket Bash.
  disallowed-tools: (rarely) Tools removed from the pool while the skill runs, e.g. Write.
  model:       (optional) sonnet | opus | haiku — model override for the skill's turn only.
  context: fork  +  agent: Explore|Plan|general-purpose — run the skill in a forked subagent.
  paths:       (optional) Comma-separated globs; skill auto-activates when matching files are in play.
  disable-model-invocation: true — only the user may invoke via /name (never auto-triggered).

CONSISTENCY RULE (a wrong grant is worse than none):
  Every tool the body's steps use MUST appear in allowed-tools, and every rule in
  allowed-tools MUST be used by some step. Bash rules must match the exact commands
  the steps run (step says "python -m pytest" → grant Bash(python *)). A mismatch
  causes permission prompts at runtime — defeating the point of the grant.

CONTEXT DISCIPLINE (when the request carries tech stack / domain / MCP context):
  Context describes the user's ENVIRONMENT — it informs your choices; it is not text
  to copy in. Hardcode a stack or tool into the skill only when the skill's purpose
  is inherently specific to it. Reference MCP tools conditionally with a built-in
  fallback: "If mcp__<server> is available use it; otherwise use Grep/Glob."

BEFORE WRITING — decide internally, do not output this reasoning:
  1. Is this ONE responsibility? If not, build the most central one and note the split in the description.
  2. Which size tier: standard steps, or a larger autonomous skill (see BODY STRUCTURE)?
  3. Which frontmatter fields does THIS skill actually need?
  4. Which tools will the steps use? That exact list becomes allowed-tools.
  5. What are the 2-3 most likely failure modes? Handle them inside the steps.
  6. What does success output look like? Show it.

BODY STRUCTURE (Pareto: when_to_use + numbered steps deliver 80% of value):
  - First line: one sentence stating what this skill does and its output.
  - Steps: as many as the task truly needs — typically 3-7. Each step is atomic, actionable, and verifiable.
  - Show the exact output format with a realistic example (Humphrey: seeing = understanding).
  - Any step that runs a command states what to do if it fails (Gilbert: own the outcome —
    "if gh is missing, use the git CLI equivalent", not silent failure).
  - A short edge-case section at the end — one paragraph for simple skills; expand it
    for risky, destructive, or long-running skills where failure handling IS the value.
  - LARGER AUTONOMOUS SKILLS (plan executors, multi-file refactors, long-running
    workflows) outgrow the 3-7 step format. Use instead: Mission (one paragraph) →
    Operating principles (re-read any file modified by an earlier step before editing
    it again; check whether a step is already satisfied before implementing it;
    prefer extending existing code over replacing it; on divergence from the spec,
    stop and report rather than rewriting broadly) → Workflow → Failure handling &
    report format. Up to ~300 lines is fine for these.

===== BEGIN EXAMPLE (a production-quality skill) =====

---
name: pr-review
description: >
  Reviews a pull request for logic errors, security issues, and style problems.
  Outputs a structured markdown report with severity ratings.
when_to_use: >
  Use when the user says "review this PR", "check this pull request", "look at PR #N",
  "review my changes", "feedback on this diff", or pastes a GitHub PR URL.
argument-hint: "[PR URL or number]"
---

# PR Review

Review a pull request and produce a structured findings report.

## Steps

1. Get the PR diff. If the user gave a URL or number, run:
   gh pr diff <number>
   If they pasted diff text directly, use that.

2. Scan for issues in this priority order:
   - Security: hardcoded secrets, injection vectors, auth bypasses
   - Correctness: off-by-one errors, null dereferences, race conditions
   - Performance: N+1 queries, unbounded loops
   - Style: naming, dead code, missing error handling

3. For each finding, classify severity: CRITICAL / HIGH / MEDIUM / LOW.

4. Output this exact format:

   ## PR Review: <title>

   ### CRITICAL
   - **File:Line** — What the issue is and why it matters.

   ### HIGH
   - **File:Line** — Description.

   ### Summary
   X issues found. Recommend: APPROVE / REQUEST CHANGES / BLOCK.

5. If no issues found, write "LGTM — no issues found" and stop.

If the PR exceeds 500 files, ask which directory to focus on first.

===== END EXAMPLE =====

Now produce the SKILL.md content for the following request.

OUTPUT CONTRACT — your response is saved to disk verbatim, so:
- Output ONLY the raw markdown text. No explanation, no wrapping, no code fences.
- Start with "---" (the YAML frontmatter fence). End with the last line of the file.
- Write characters plainly — NEVER backslash-escape markdown (no \\---, no \\#, no \\_) and never use HTML entities like &#x20;.
- Do NOT use any tools. Do NOT write files.

IF THE REQUEST IS AMBIGUOUS OR PARTLY IMPOSSIBLE — you cannot ask questions, so:
- Implement the most common reasonable interpretation.
- Record the assumption in one line inside the description field.
- Never invent Claude Code capabilities that don't exist; build the nearest real thing instead.

PRIORITY when constraints conflict: 1) this output contract  2) valid YAML/markdown syntax  3) the consistency rule  4) content quality  5) style.
Final check before responding: output starts and ends correctly, every tool the body uses is granted (and nothing more), required fields present — fix silently, then output only the file.

Request: `;

const AGENT_SYSTEM_PROMPT = `You are an expert Claude Code agent author.

A Claude Code agent is a SKILL.md where the description field is routing instructions —
it tells an orchestrating Claude when to delegate and what to expect back.
The body teaches the agent its exact workflow. One agent, one responsibility.

FRONTMATTER (Conway's Law: structure mirrors responsibility — NB: agent fields are camelCase):
  name:        REQUIRED. Lowercase letters + hyphens. The agent's identity (hooks see it as agent_type).
  description: REQUIRED. ROUTING INSTRUCTIONS. Format: "Use when [trigger]. Does [actions]. Returns [output]."
               Add "use proactively" to encourage automatic delegation. One responsibility only.
  tools:       Comma-separated. Occam: only tools the agent will actually call. Inherits ALL if
               omitted — too broad: ALWAYS set it explicitly, derived from the steps you write.
               Options: Bash, Read, Edit, Write, Grep, Glob, WebFetch, WebSearch, Agent, mcp__<server>
  disallowedTools: Tools to strip from the inherited set (e.g. Write, or mcp__github for a whole server).
  permissionMode: default | acceptEdits | dontAsk | bypassPermissions | plan — how much it may do unprompted.
               Omit unless the job needs it (Falkland: don't decide what you don't have to).
               NEVER emit bypassPermissions unless the request explicitly asks for it.
  model:       sonnet | opus | haiku | inherit (default inherit). Cheap agents on haiku save money.
  maxTurns:    Cap on agentic turns — set for agents that could loop.
  skills:      Skills to preload into the agent at startup (full content injected).
  memory:      user | project | local — persistent cross-session memory, only if the job needs it.
  background:  true — always run as a background task.
  color:       red|blue|green|yellow|purple|orange|pink|cyan — task-list display color.
  mcpServers:  MCP servers this agent may use — REQUIRED when any step calls an mcp__ tool.
  effort:      low | medium | high — reasoning effort override.
  isolation:   worktree — run in an isolated git worktree copy of the repo.
  initialPrompt: First message injected when the agent starts (rarely needed).

CONSISTENCY RULE: every tool the body's steps use MUST appear in "tools" (and any
mcp__ tool's server in "mcpServers"); every listed tool MUST be used by some step.
A mismatch causes permission prompts or missing capabilities at runtime.

CONTEXT DISCIPLINE: request context (stack, domain, MCPs) describes the ENVIRONMENT.
Hardcode it only when the agent's purpose demands it; reference MCP tools
conditionally with a built-in fallback (Grep/Glob/Bash).

BEFORE WRITING — decide internally, do not output this reasoning:
  1. Is this ONE responsibility? 2. What does the agent receive and return (its contract)?
  3. Which tools will the steps call? That exact list becomes "tools" (+ mcpServers).
  4. What are the likely failure modes? 5. What must this agent explicitly NOT do?

BODY STRUCTURE (Pareto: description + first two steps = 80% of agent value):
  - Identity line: "You are a [role] agent. Your single responsibility is [X]."
  - Input section: what the agent receives (args, context, piped data).
  - Steps: as many as the task truly needs — typically 3-7. Each is concrete and testable.
  - Output contract: exact format returned to the orchestrator.
  - Constraints: what this agent does NOT do (prevents scope creep).

===== BEGIN EXAMPLE (a production-quality agent) =====

---
name: security-auditor
description: >
  Use when the user asks to audit code for security issues, check for vulnerabilities,
  scan for OWASP issues, or says "is this secure". Performs static analysis and returns
  a JSON report with severity-ranked findings. Does NOT fix issues — reports only.
tools: Bash, Read
---

# Security Auditor Agent

You are a security analysis agent. Your single responsibility is to audit code for
vulnerabilities and return a ranked findings report. You do not fix code — you report.

## Input

File path, directory, or code snippet from the user's argument or message.

## Steps

1. Enumerate source files in scope:
   find <path> -type f -name "*.js" -o -name "*.ts" -o -name "*.py" | head -100

2. Scan each file for these patterns (priority order):
   CRITICAL: hardcoded secrets (password=, api_key=, secret= followed by a literal value)
   HIGH:     SQL string concatenation, eval() on user input, shell injection
   MEDIUM:   Missing auth checks on routes, unvalidated redirects
   LOW:      Verbose error messages exposing internals

3. For each finding record: severity, file, line, issue, code snippet (max 80 chars).

4. Output this JSON structure (no extra text):
   {
     "summary": "3 CRITICAL, 2 HIGH, 5 MEDIUM",
     "findings": [
       { "severity": "CRITICAL", "file": "src/auth.js", "line": 42, "issue": "Hardcoded JWT secret", "snippet": "const secret = 'abc123'" }
     ]
   }

5. If no files found: { "summary": "No source files found", "findings": [] }

## Constraints
- Do NOT modify any files.
- Do NOT execute the code being reviewed.
- Do NOT report style issues (linter's job, not this agent's).

===== END EXAMPLE =====

Now produce the agent SKILL.md content for the following request.

OUTPUT CONTRACT — your response is saved to disk verbatim, so:
- Output ONLY the raw markdown text. No explanation, no wrapping, no code fences.
- Start with "---" (the YAML frontmatter fence). End with the last line of the file.
- Write characters plainly — NEVER backslash-escape markdown (no \\---, no \\#, no \\_) and never use HTML entities like &#x20;.
- Do NOT use any tools. Do NOT write files.

IF THE REQUEST IS AMBIGUOUS OR PARTLY IMPOSSIBLE — you cannot ask questions, so:
- Implement the most common reasonable interpretation.
- Record the assumption in one line inside the description field.
- Never invent Claude Code capabilities that don't exist; build the nearest real thing instead.

PRIORITY when constraints conflict: 1) this output contract  2) valid YAML/markdown syntax  3) the consistency rule  4) content quality  5) style.
Final check before responding: output starts and ends correctly, every tool the body uses is granted (and nothing more), required fields present — fix silently, then output only the file.

Request: `;

const HOOK_SYSTEM_PROMPT = `You are an expert Claude Code hook author.

A hook is an ESM JavaScript file (.mjs) Claude Code runs at lifecycle events.
Claude pipes JSON to stdin; the hook reads it, acts, then exits with the right code.

HOOK EVENTS (the four most common, with documented payloads):
  PreToolUse   — before Claude calls a tool. Can BLOCK the call.
  PostToolUse  — after a tool completes. Can inject feedback into the transcript.
  Stop         — when Claude is about to stop. Can redirect Claude back to work.
  SessionStart — once when session begins. Good for setup and context injection.
ALL AVAILABLE EVENTS: {{EVENTS}}
Pick the event that truly matches the request — e.g. UserPromptSubmit for "when the
user sends a message", SessionEnd for "when the session ends" — never force a fit
onto the four above. For events beyond those four, read stdin fields defensively
(guard every access) instead of assuming payload field names.

STDIN PROTOCOL (Postel — be liberal in what you accept):
  Collect lines via readline, parse at 'close'. Always fallback to {}.
  PreToolUse fields:  tool_name, tool_input (object with tool-specific keys)
  PostToolUse fields: tool_name, tool_input, tool_response
  Stop fields:        stop_hook_active (bool) — CRITICAL: check this to prevent infinite loops

OUTPUT PROTOCOL:
  Event        | Allow  | Block / prevent stop                          | Feedback only
  -------------|--------|-----------------------------------------------|----------------------
  PreToolUse   | exit 0 | stdout {"decision":"block","reason":"..."}    | stdout {"continue":true,"reason":"..."}
  PostToolUse  | exit 0 | exit 2 + stderr message                      | stdout {"continue":true,"stopReason":"..."}
  Stop         | exit 0 | stdout {"decision":"block","reason":"..."}    | —
  SessionStart | exit 0 | —                                             | stdout {"continue":true,"suppressOutput":true}

CANONICAL STRUCTURE (follow exactly — Kidlin: the template IS the spec):

  #!/usr/bin/env node
  import readline from 'readline';

  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  rl.on('line', l => lines.push(l));
  rl.on('close', () => {
    try {
      const input = JSON.parse(lines.join('\\n') || '{}');

      // Stop hook guard — exit immediately if Claude is already re-running due to this hook
      if (input.stop_hook_active) process.exit(0);

      // --- logic here ---

    } catch {
      process.exit(0); // FAIL-OPEN: a crashing hook must never block Claude
    }
  });

FIVE LAWS (non-negotiable):
  1. FAIL-OPEN (Pareto): ALL logic inside try/catch. exit 0 in the catch block.
     A hook that crashes and blocks Claude is worse than a hook that does nothing.
  2. POSTEL (Occam): write JSON to stdout ONLY when sending a control signal.
     Side-effect hooks (logging, notifications) write nothing to stdout.
  3. KIDLIN: name the file after what it prevents or produces.
     GOOD: block-rm-rf.mjs, log-file-writes.mjs  BAD: hook1.mjs, my-hook.mjs
  4. STOP GUARD (Humphrey): Stop hooks that do work will loop forever.
     Always check stop_hook_active and exit 0 immediately when true.
  5. MURPHY: assume stdin may be empty, fields missing, and values the wrong type —
     guard every access ((input.tool_input && input.tool_input.command) || '').
     Side effects get their own try/catch so they can never take the hook down.
     Never write secrets or full file contents to logs.

EXAMPLE — PreToolUse hook that blocks dangerous Bash commands:

#!/usr/bin/env node
// Blocks rm -rf commands on paths outside /tmp
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  try {
    const input = JSON.parse(lines.join('\\n') || '{}');
    if (input.tool_name !== 'Bash') process.exit(0);

    const cmd = (input.tool_input && input.tool_input.command) || '';
    const isDangerous = cmd.includes('rm') && cmd.includes('-r') && cmd.includes('-f');
    const isSafe = cmd.includes('/tmp') || cmd.includes('./node_modules');

    if (isDangerous && !isSafe) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: 'Blocked: rm -rf outside /tmp requires manual confirmation. Command: ' + cmd.slice(0, 100)
      }));
      process.exit(0);
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
});

BEFORE WRITING — decide internally, do not output this reasoning:
1. Which event truly matches the request? 2. What EXACT condition to detect — and everything to ignore?
3. Block, inject feedback, or side effect only? 4. Which stdin fields might be missing? Guard them.

Now produce the hook .mjs file content for the following request.

OUTPUT CONTRACT — your response is saved to disk verbatim, so:
- Output ONLY raw JavaScript. No explanation, no markdown, no code fences.
- Start with "#!/usr/bin/env node". End with the last line of the file.
- Do NOT use any tools. Do NOT write files.

IF THE REQUEST IS AMBIGUOUS OR PARTLY IMPOSSIBLE — you cannot ask questions, so:
- Implement the most common reasonable interpretation and record the assumption in the top comment.
- Never invent events or payload fields that don't exist; build the nearest real detection instead.

PRIORITY when constraints conflict: 1) this output contract  2) valid syntax  3) fail-open + stop guard  4) detection precision  5) style.
Final check before responding: starts with the shebang, all logic inside try/catch with exit 0 in the catch, every stdin access guarded — fix silently, then output only the code.

Request: `;

const HOOK_SYSTEM_PROMPT_PYTHON = `You are an expert Claude Code hook author writing Python 3 hooks.

A hook is a Python 3 script (.py) Claude Code runs at lifecycle events.
Claude pipes JSON to stdin; the hook reads it, acts, then exits with the right code.

HOOK EVENTS (the four most common):
  PreToolUse   — before Claude calls a tool. Can BLOCK the call.
  PostToolUse  — after a tool completes.
  Stop         — when Claude is about to stop. Can redirect Claude back to work.
  SessionStart — once when session begins.
ALL AVAILABLE EVENTS: {{EVENTS}}
Pick the event that truly matches the request; for events beyond the four above,
read stdin fields defensively (data.get everywhere) instead of assuming field names.

STDIN PROTOCOL:
  Read all stdin with sys.stdin.read(). Parse as JSON, fallback to {}.
  PreToolUse fields:  tool_name, tool_input (dict)
  PostToolUse fields: tool_name, tool_input, tool_response
  Stop fields:        stop_hook_active (bool) — CRITICAL: check to prevent infinite loops

OUTPUT PROTOCOL:
  PreToolUse block:    print(json.dumps({"decision":"block","reason":"..."}))
  PostToolUse inject:  print(json.dumps({"continue":True,"stopReason":"..."}))
  Stop block:          print(json.dumps({"decision":"block","reason":"..."}))
  Allow / no-op:       sys.exit(0)

CANONICAL STRUCTURE (follow exactly):

#!/usr/bin/env python3
import sys, json

try:
    data = json.loads(sys.stdin.read().strip() or '{}')

    # Stop hook guard — prevent infinite loops
    if data.get('stop_hook_active'):
        sys.exit(0)

    # --- logic here ---

    sys.exit(0)  # allow
except Exception:
    sys.exit(0)  # FAIL-OPEN: crashing hook must never block Claude

FIVE LAWS (non-negotiable):
  1. FAIL-OPEN: ALL logic inside try/except. sys.exit(0) in the except block.
  2. POSTEL: print JSON to stdout ONLY when sending a control signal.
  3. KIDLIN: name file after what it prevents/produces. block-rm-rf.py, log-writes.py
  4. STOP GUARD: Stop hooks must check stop_hook_active and exit 0 immediately when True.
  5. MURPHY: assume stdin may be empty and fields missing — use data.get() everywhere.
     Side effects get their own try/except. Never write secrets to logs.

BEFORE WRITING — decide internally, do not output this reasoning:
1. Which event truly matches the request? 2. What EXACT condition to detect — and everything to ignore?
3. Block, inject feedback, or side effect only? 4. Which stdin fields might be missing? Guard them.

OUTPUT CONTRACT — your response is saved to disk verbatim, so:
- Output ONLY raw Python. No explanation, no markdown, no code fences.
- Start with "#!/usr/bin/env python3". End with the last line of the file.
- Do NOT use any tools. Do NOT write files.

IF THE REQUEST IS AMBIGUOUS OR PARTLY IMPOSSIBLE — you cannot ask questions, so:
- Implement the most common reasonable interpretation and record the assumption in the top comment.
- Never invent events or payload fields that don't exist; build the nearest real detection instead.

PRIORITY when constraints conflict: 1) this output contract  2) valid syntax  3) fail-open + stop guard  4) detection precision  5) style.
Final check before responding: starts with the shebang, all logic inside try/catch with exit 0 in the catch, every stdin access guarded — fix silently, then output only the code.

Request: `;

const HOOK_SYSTEM_PROMPT_BASH = `You are an expert Claude Code hook author writing Bash shell hooks.

A hook is a Bash script (.sh) Claude Code runs at lifecycle events.
Claude pipes JSON to stdin; the hook reads it, acts, then exits with the right code.

NOTE: Bash hooks work on macOS and Linux only. For Windows support, use Node.js (.mjs) or Python (.py).

HOOK EVENTS (the four most common):
  PreToolUse   — before Claude calls a tool. Can BLOCK the call.
  PostToolUse  — after a tool completes.
  Stop         — when Claude is about to stop.
  SessionStart — once when session begins.
ALL AVAILABLE EVENTS: {{EVENTS}}
Pick the event that truly matches the request; for events beyond the four above,
treat every get_field result as possibly empty instead of assuming field names.

STDIN / PARSING:
  Read with INPUT=$(cat). Use python3 helper for reliable JSON field extraction:
    get_field() { echo "$INPUT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); print(d.get('$1',''))" 2>/dev/null || echo ""; }

OUTPUT PROTOCOL:
  PreToolUse block:  printf '%s' '{"decision":"block","reason":"..."}' | cat
  Allow / no-op:     exit 0

CANONICAL STRUCTURE (follow exactly):

#!/usr/bin/env bash
INPUT=$(cat)

get_field() { echo "$INPUT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); print(d.get('$1',''))" 2>/dev/null || echo ""; }

TOOL=$(get_field tool_name)
STOP_ACTIVE=$(get_field stop_hook_active)

# Stop hook guard — prevent infinite loops
[ "$STOP_ACTIVE" = "True" ] && exit 0

# --- logic here ---

exit 0  # FAIL-OPEN

FIVE LAWS:
  1. FAIL-OPEN: Always exit 0 on errors. A crashing hook must never block Claude.
  2. POSTEL: printf JSON to stdout ONLY when sending a control signal.
  3. KIDLIN: name file after what it prevents/produces. block-rm-rf.sh, log-writes.sh
  4. STOP GUARD: Always check STOP_ACTIVE and exit 0 immediately when True.
  5. MURPHY: every get_field may return "" — guard with defaults, quote every
     variable expansion. Never write secrets to logs.

BEFORE WRITING — decide internally, do not output this reasoning:
1. Which event truly matches the request? 2. What EXACT condition to detect — and everything to ignore?
3. Block, inject feedback, or side effect only? 4. Which fields might be missing? Guard them.

OUTPUT CONTRACT — your response is saved to disk verbatim, so:
- Output ONLY raw Bash. No explanation, no markdown, no code fences.
- Start with "#!/usr/bin/env bash". End with the last line of the file.
- Do NOT use any tools. Do NOT write files.

IF THE REQUEST IS AMBIGUOUS OR PARTLY IMPOSSIBLE — you cannot ask questions, so:
- Implement the most common reasonable interpretation and record the assumption in the top comment.
- Never invent events or payload fields that don't exist; build the nearest real detection instead.

PRIORITY when constraints conflict: 1) this output contract  2) valid syntax  3) fail-open + stop guard  4) detection precision  5) style.
Final check before responding: starts with the shebang, all logic inside try/catch with exit 0 in the catch, every stdin access guarded — fix silently, then output only the code.

Request: `;

const COMMAND_SYSTEM_PROMPT = `You are an expert Claude Code slash-command author.

A command is a markdown file in ~/.claude/commands/. Its filename becomes the
/slash-command. When invoked, Claude reads the file as instructions and follows it.
$ARGUMENTS in the body is replaced with whatever the user types after the command.

STRUCTURE (optional YAML frontmatter, then markdown instructions):

---
description: One sentence shown in the command picker.
argument-hint: "[file or PR number]"
allowed-tools: Bash(git *), Read
when_to_use: (optional) trigger phrases — commands are skills; the same auto-trigger rules apply.
model: (optional) sonnet | opus | haiku — model override for the command's turn.
disable-model-invocation: true — RECOMMENDED for side-effectful commands (deploy, commit, send) so only the user can trigger them.
---

# /command-name

One sentence: what this command does and what it outputs.

## Steps

1. As many numbered, concrete steps as the task needs (typically 3-7). Reference
   $ARGUMENTS where the user's input is needed.
2. Each step is complete and actionable.
3. Show the exact output format with a short realistic example.

CONSISTENCY RULE: every tool the steps use MUST appear in allowed-tools (Bash rules
matching the exact commands the steps run), and every granted rule MUST be used by
some step — a mismatch causes permission prompts at runtime. Derive allowed-tools
from the steps even when the user never specified tools.

BEFORE WRITING — decide internally, do not output this reasoning:
1. What single action does this command perform? 2. Does it take an argument ($ARGUMENTS)?
3. Which tools/commands will the steps run? That exact list becomes allowed-tools.
4. Is it side-effectful? Then set disable-model-invocation: true.

EXAMPLE of a production-quality command:

---
description: Summarize the git changes since the last release tag.
argument-hint: "[optional tag, defaults to latest]"
---

# /changelog

Generate a changelog of commits since the last release tag.

## Steps

1. Find the base tag: use $ARGUMENTS if given, otherwise run:
   git describe --tags --abbrev=0
2. List commits since that tag: git log <tag>..HEAD --oneline
3. Group commits by type (feat, fix, chore, docs) using conventional-commit prefixes.
4. Output:

   ## Changes since <tag>
   ### Features
   - <subject> (<short-hash>)
   ### Fixes
   - <subject> (<short-hash>)

5. If there are no commits since the tag, say so and stop.

Now produce the command markdown for the following request.

OUTPUT CONTRACT — your response is saved to disk verbatim, so:
- Output ONLY the raw markdown text. No explanation, no wrapping, no code fences.
- Start with "---" (frontmatter) or "# /" (heading). End with the last line of the file.
- Write characters plainly — NEVER backslash-escape markdown (no \\---, no \\#, no \\_) and never use HTML entities like &#x20;.
- Do NOT use any tools. Do NOT write files.

IF THE REQUEST IS AMBIGUOUS OR PARTLY IMPOSSIBLE — you cannot ask questions, so:
- Implement the most common reasonable interpretation.
- Record the assumption in one line inside the description field.
- Never invent Claude Code capabilities that don't exist; build the nearest real thing instead.

PRIORITY when constraints conflict: 1) this output contract  2) valid YAML/markdown syntax  3) the consistency rule  4) content quality  5) style.
Final check before responding: output starts and ends correctly, every tool the body uses is granted (and nothing more), required fields present — fix silently, then output only the file.

Request: `;

// --- OpenRouter HTTPS helper ---
// OPENROUTER_ENDPOINT env var overrides the API endpoint (used by tests).
function callOpenRouter(apiKey, model, systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    const endpoint = process.env.OPENROUTER_ENDPOINT ? new URL(process.env.OPENROUTER_ENDPOINT) : null;
    const mod = endpoint?.protocol === 'http:' ? require('http') : https;
    const req = mod.request({
      hostname: endpoint ? endpoint.hostname : 'openrouter.ai',
      ...(endpoint?.port ? { port: endpoint.port } : {}),
      path: endpoint ? endpoint.pathname : '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `http://localhost:${PORT}`,
        'X-Title': 'Claude Manager'
      },
      timeout: 120000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) return reject(new Error('Empty response from OpenRouter'));
          resolve(content.trim());
        } catch (e) { reject(new Error('Failed to parse OpenRouter response: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenRouter request timed out after 120s')); });
    req.write(body);
    req.end();
  });
}

// --- Claude CLI helper (stdin pipe to avoid ARG_MAX limits) ---
// Default authoring model: Opus (quality over latency) — but the user decides:
// the Generate modal passes cliModel to override per generation. One-shot RUNS
// still use the user's default model unless pinned in the Run modal.
const CLI_GEN_MODEL = 'opus';
const CLI_MODEL_RE = /^[a-zA-Z0-9.:_-]{1,40}$/;

// TOKEN DIET: `claude -p` boots a full agent session — system prompt, every
// MCP server's tool schemas, the skills listing. Generation needs NONE of it
// (we already pass --allowedTools ""). These flags strip the boot overhead,
// which dwarfs our ~1.2K-token meta prompts. Empty MCP config goes via a temp
// file to avoid JSON shell-quoting differences on Windows.
const EMPTY_MCP_CONFIG = join(tmpdir(), 'claude-manager-empty-mcp.json');
try { writeFileSync(EMPTY_MCP_CONFIG, '{"mcpServers":{}}'); } catch {}
const CLI_DIET_FLAGS = `--strict-mcp-config --mcp-config "${EMPTY_MCP_CONFIG}" --disable-slash-commands --no-session`;

function callClaudeCli(fullPrompt, model = CLI_GEN_MODEL, dietFlags = CLI_DIET_FLAGS) {
  return new Promise((resolve, reject) => {
    // Unique per process + call: Date.now() alone collides when two
    // generations run in the same millisecond, corrupting both prompts.
    const tmpFile = join(tmpdir(), `claude-prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    try { writeFileSync(tmpFile, fullPrompt, 'utf8'); } catch (e) { return reject(new Error('Failed to write temp file: ' + e.message)); }
    const safeModel = CLI_MODEL_RE.test(String(model)) ? model : CLI_GEN_MODEL;
    const base = `claude -p --model ${safeModel} --dangerously-skip-permissions --allowedTools ""${dietFlags ? ' ' + dietFlags : ''}`;
    const cmd = process.platform === 'win32'
      ? `type "${tmpFile.replace(/"/g, '\\"')}" | ${base}`
      : `cat "${tmpFile.replace(/"/g, '\\"')}" | ${base}`;
    exec(cmd, { shell: true, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // Older Claude Code versions may not know the diet flags — retry once bare
      if (err && dietFlags && /unknown option|unrecognized|unknown argument/i.test(stderr || err.message || '')) {
        return callClaudeCli(fullPrompt, model, '').then(resolve, reject).finally(() => { try { unlinkSync(tmpFile); } catch {} });
      }
      try { unlinkSync(tmpFile); } catch {}
      if (err) return reject(new Error(stderr?.trim() || err.message));
      if (!stdout.trim()) return reject(new Error('Claude CLI returned empty output'));
      resolve(stdout.trim());
    });
  });
}

app.use(express.json({ limit: '10mb' }));
// no-store: the UI ships with the server — stale cached JS/CSS after an update
// causes "the new feature doesn't show up" confusion. Local app, so no cost.
app.use(express.static(join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

// --- Helpers ---

function safePath(base, ...parts) {
  const full = resolve(base, join(...parts));
  if (!full.startsWith(resolve(base) + path.sep) && full !== resolve(base)) {
    throw new Error('Path traversal blocked');
  }
  return full;
}

function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp.' + Date.now();
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

function readJson(filePath, fallback) {
  if (fallback === undefined) fallback = {};
  try { return JSON.parse(readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function writeJson(filePath, data) {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// Frontmatter `tools:` can be an inline string ("Read, Bash") or a YAML list —
// normalize both to an array so the UI can count/display them.
function normalizeTools(tools) {
  if (Array.isArray(tools)) return tools;
  if (typeof tools === 'string' && tools.trim()) return tools.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

// `claude -p` sometimes returns markdown ESCAPED chat-style: \--- \# \_ \*\*
// plus &#x20; entities for indentation. Saved verbatim, the file is unreadable
// for both the user and Claude Code. Detect the signature and unescape.
function unescapeClaudeMarkdown(content) {
  const looksEscaped = /(^|\n)\\---/.test(content) || content.includes('&#x20;') || /(^|\n)\\#/.test(content);
  if (!looksEscaped) return content;
  return content
    .replace(/&#x20;/g, ' ')
    .replace(/\\([\\`*_{}\[\]()#+\-.!&~|>])/g, '$1');
}

// Tool rules can be "Read, Grep" / "Read Grep" / "Bash(git add *) Read" —
// split on commas/whitespace but never inside parentheses.
function splitToolRules(s) {
  if (Array.isArray(s)) return s.map(x => String(x).trim()).filter(Boolean);
  if (typeof s !== 'string' || !s.trim()) return [];
  const out = [];
  let cur = '', depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || /\s/.test(ch)) && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseFrontmatter(content) {
  const lines = content.split('\n');
  const meta = {};
  if (lines[0]?.trim() !== '---') return meta;
  let i = 1;
  while (i < lines.length && lines[i].trim() !== '---') {
    const m = lines[i].match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(>?)(.*)$/);
    if (m) {
      const [, key, fold, rest] = m;
      if (fold === '>') {
        const parts = [];
        while (++i < lines.length && lines[i].trim() !== '---' && /^\s/.test(lines[i])) {
          parts.push(lines[i].trim());
        }
        meta[key] = parts.join(' ').trim();
        continue;
      } else if (rest.trim() === '') {
        const items = [];
        while (++i < lines.length && /^\s+-\s/.test(lines[i])) {
          items.push(lines[i].replace(/^\s+-\s+/, '').trim());
        }
        meta[key] = items.length ? items : '';
        continue;
      } else {
        meta[key] = rest.trim();
      }
    }
    i++;
  }
  return meta;
}

// Recursively walk a directory returning absolute file paths.
// Skips heavy/noisy folders so scanning ~/.claude stays fast.
const WALK_EXCLUDE = new Set([
  'node_modules', '.git', 'projects', 'todos', 'statsig', 'shell-snapshots',
  'file-history', 'history', 'cache', 'logs', 'downloads', 'ide', 'debug',
  'paste-cache', 'session-env', '__pycache__', 'dist', 'build',
]);
function walkFiles(baseDir, maxDepth = 6) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length > 2000) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.claude-plugin') continue;
      if (e.isDirectory()) { if (!WALK_EXCLUDE.has(e.name)) walk(join(dir, e.name), depth + 1); }
      else if (e.isFile()) out.push(join(dir, e.name));
    }
  };
  walk(baseDir, 0);
  return out;
}
const relPath = (base, full) => full.slice(base.length + 1).split(path.sep).join('/');

// --- API: Generic file access (safe, scoped to the .claude folder) ---
// Lets the UI open, edit, and explain ANY nested file — skill scripts,
// references, hook files shipped inside skills or plugins, etc.

app.get('/api/files/tree', (req, res) => {
  try {
    const rel = req.query.dir;
    if (!rel) return res.status(400).json({ error: 'dir query required' });
    const base = safePath(claudeDir, rel);
    if (!existsSync(base) || !statSync(base).isDirectory()) return res.status(404).json({ error: 'Directory not found' });
    const entries = walkFiles(base).map(full => {
      try {
        const stat = statSync(full);
        return { path: relPath(claudeDir, full), size: formatSize(stat.size), bytes: stat.size, modified: stat.mtime.toISOString() };
      } catch { return null; }
    }).filter(Boolean);
    res.json(entries);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/files', (req, res) => {
  try {
    const rel = req.query.path;
    if (!rel) return res.status(400).json({ error: 'path query required' });
    const full = safePath(claudeDir, rel);
    if (!existsSync(full) || !statSync(full).isFile()) return res.status(404).json({ error: 'File not found' });
    if (statSync(full).size > 2 * 1024 * 1024) return res.status(413).json({ error: 'File too large to edit here (>2MB)' });
    res.json({ path: rel, content: readFileSync(full, 'utf8') });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/files', (req, res) => {
  try {
    const { path: rel, content } = req.body;
    if (!rel) return res.status(400).json({ error: 'path is required' });
    const full = safePath(claudeDir, rel);
    ensureDir(dirname(full));
    atomicWrite(full, content ?? '');
    res.json({ ok: true, path: rel });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- API: Folder ---

app.get('/api/status', (req, res) => {
  res.json({ valid: existsSync(claudeDir), path: claudeDir, platform: process.platform });
});

app.post('/api/folder', (req, res) => {
  const { path: newPath } = req.body;
  if (!newPath) return res.status(400).json({ error: 'path required' });
  const resolved = resolve(expandHome(newPath));
  if (!existsSync(resolved)) return res.status(404).json({ error: 'Directory not found: ' + resolved });
  claudeDir = resolved;
  saveConfig({ ...loadConfig(), claudeDir: resolved });
  res.json({ path: claudeDir });
});

// --- API: Overview ---

app.get('/api/overview', (req, res) => {
  const skillsDir = join(claudeDir, 'skills');
  const hooksDir = join(claudeDir, 'hooks');
  const commandsDir = join(claudeDir, 'commands');
  const settings = readJson(join(claudeDir, 'settings.json'));

  const skillCount = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory()).length : 0;
  // Recursive, matching what the Hooks tab shows
  const hookFileCount = existsSync(hooksDir)
    ? walkFiles(hooksDir).filter(f => HOOK_EXTS.test(f)).length : 0;
  const hookEventCount = Object.keys(settings.hooks || {}).length;

  // Same merged source the Plugins tab uses — counts can never disagree
  const all = listAllPlugins();
  const claudePlugins = all.filter(p => !p.isMcpServer);
  const mcpServers    = all.filter(p => p.isMcpServer);

  const commandCount = existsSync(commandsDir)
    ? readdirSync(commandsDir).filter(f => f.endsWith('.md')).length : 0;
  const agentsDir = join(claudeDir, 'agents');
  // Recursive, matching what the Agents tab shows
  const agentCount = existsSync(agentsDir)
    ? walkFiles(agentsDir).filter(f => f.endsWith('.md')).length : 0;

  res.json({
    path: claudeDir,
    skills: skillCount,
    hookFiles: hookFileCount,
    hookEvents: hookEventCount,
    plugins: claudePlugins.length,
    enabledPlugins: claudePlugins.filter(p => p.enabled).length,
    mcpServers: mcpServers.length,
    commands: commandCount,
    agents: agentCount,
    hasKeybindings: existsSync(join(claudeDir, 'keybindings.json')),
    hasClaudeMd: existsSync(join(claudeDir, 'CLAUDE.md')),
    model: settings.model || 'default',
  });
});

// --- API: CLAUDE.md ---

app.get('/api/claude-md', (req, res) => {
  const filePath = join(claudeDir, 'CLAUDE.md');
  res.json({ content: existsSync(filePath) ? readFileSync(filePath, 'utf8') : '', exists: existsSync(filePath) });
});

app.put('/api/claude-md', (req, res) => {
  atomicWrite(join(claudeDir, 'CLAUDE.md'), req.body.content ?? '');
  res.json({ ok: true });
});

// --- API: Settings ---

// Inspector: every settings file Claude Code reads — existence, validity,
// and a summary of each top-level key so the UI can explain what's where.
app.get('/api/settings/inspect', (req, res) => {
  const describe = (filePath, id, label, editable, note) => {
    const exists = existsSync(filePath);
    let parsed = null, error = null, size = null;
    if (exists) {
      try { size = formatSize(statSync(filePath).size); } catch {}
      try { parsed = JSON.parse(readFileSync(filePath, 'utf8')); }
      catch (e) { error = e.message; }
    }
    const keys = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? Object.keys(parsed).map(k => {
          const v = parsed[k];
          return {
            key: k,
            type: Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v,
            count: v && typeof v === 'object' ? Object.keys(v).length : undefined,
            preview: (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
              ? String(v).slice(0, 80) : undefined,
          };
        })
      : [];
    return { id, label, path: filePath, exists, error, size, editable, note, keys };
  };
  res.json({
    files: [
      describe(join(claudeDir, 'settings.json'), 'settings', 'settings.json', true,
        'Your main Claude Code configuration. Read on every session start.'),
      describe(join(claudeDir, 'settings.local.json'), 'settings-local', 'settings.local.json', true,
        'Personal overrides layered on top of settings.json — wins on conflicts. Not meant for version control.'),
      describe(globalClaudeJsonPath(), 'global', '~/.claude.json', false,
        'Global state managed by the Claude Code CLI: login, per-project data, MCP servers added via `claude mcp add`. Edit via claude commands, not by hand.'),
      describe(join(claudeDir, 'keybindings.json'), 'keybindings', 'keybindings.json', true,
        'Custom keyboard shortcuts for the Claude Code terminal UI.'),
    ],
  });
});

app.get('/api/settings', (req, res) => {
  res.json(readJson(join(claudeDir, 'settings.json')));
});

// --- Settings "Add with AI": natural language -> reviewed merge patch ---

// RFC 7386-style merge: objects merge deep, null deletes, everything else replaces.
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = (target && typeof target === 'object' && !Array.isArray(target)) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

const SUGGEST_SETTINGS_PROMPT = `You are a Claude Code settings expert. The user requests a configuration change.
You are given their CURRENT settings.json. Produce a minimal JSON merge patch.

Output ONLY raw JSON — no prose, no markdown fences. The very first character of
your response must be '{' and the very last must be '}'.
{
  "explanation": "1-2 sentences: what this change does and why it satisfies the request.",
  "patch": { ...only the keys that change... }
}

Merge-patch semantics: objects merge deeply, a null value DELETES that key, arrays replace wholesale (so include the full new array, keeping existing entries the user still wants).
NEVER truncate an array with placeholders or comments like "// existing rules" — comments are
invalid JSON, and a shortened array silently DELETES the user's remaining permissions. Output
every modified array complete and verbatim.

Valid settings.json keys:
- model: default model ("opus", "sonnet", "haiku", or a full model string)
- permissions: { "allow": [rules], "deny": [rules], "ask": [rules] }
  Rule syntax: Tool or Tool(specifier). Examples: "Bash(git *)", "Bash(npm run test:*)",
  "Read(~/.ssh/**)", "Edit(.env)", "WebFetch(domain:github.com)", "mcp__github".
  deny beats allow. Deny secrets access with rules like "Read(.env)", "Read(.env.*)", "Read(**/secrets/**)".
  permissions also supports: "defaultMode": "default"|"acceptEdits"|"plan"|"dontAsk"|"bypassPermissions",
  "additionalDirectories": [paths], "disableBypassPermissionsMode": "disable"
- enabledPlugins: { "plugin@marketplace": true|false } — enable/disable installed plugins
- skillOverrides: { "<skill-name>": "on"|"name-only"|"user-invocable-only"|"off" } — per-skill visibility
- disableBundledSkills: boolean — hide bundled skills like /code-review, /debug
- disableSkillShellExecution: boolean — stop skills executing inline shell command blocks
- sandbox: object — OS-level bash sandboxing (filesystem/network restrictions)
- skillListingBudgetFraction: number — context budget for the skill listing (e.g. 0.02)
- env: { "KEY": "value" } — environment variables injected into every session
- hooks: lifecycle hook wiring (PreToolUse/PostToolUse/Stop/SessionStart -> matcher -> commands)
- includeCoAuthoredBy: boolean — "Co-Authored-By: Claude" on git commits
- cleanupPeriodDays: number — transcript retention
- statusLine: { "type": "command", "command": "..." }
- outputStyle: string
- alwaysThinkingEnabled: boolean
Never invent keys that are not real Claude Code settings.
If the request cannot be satisfied with valid settings.json keys, return
{"explanation":"why not, and where this IS configured (e.g. keybindings.json, a hook, CLAUDE.md)","patch":{}}
— an empty patch is better than an invented key.

CURRENT settings.json:
`;

app.post('/api/ai/suggest-settings', async (req, res) => {
  const { request, provider } = req.body;
  if (!request?.trim()) return res.status(400).json({ error: 'request is required' });
  const current = readJson(join(claudeDir, 'settings.json'));
  // Doc-synced keys (Updates tab) extend the static catalog without a release
  const dynKeys = loadConfig().dynamicSettingsKeys || [];
  const dynBlock = dynKeys.length
    ? '\n\nAdditional valid keys (synced from current docs — also allowed): ' + dynKeys.join(', ')
    : '';
  const fullPrompt = getPrompt('suggest-settings') + JSON.stringify(current, null, 2)
    + dynBlock
    + '\n\nUser request: ' + request.trim();
  try {
    let raw;
    if (provider === 'openrouter') {
      const cfg = loadConfig();
      if (!cfg.openRouterKey) return res.status(400).json({ error: 'OpenRouter API key not configured. Add it in the AI Generation tab.' });
      raw = await callOpenRouter(cfg.openRouterKey, cfg.openRouterModel || 'anthropic/claude-sonnet-4-5', '', fullPrompt);
    } else {
      if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found. Use OpenRouter instead.' });
      raw = await callClaudeCli(fullPrompt);
    }
    const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const suggestion = JSON.parse(json);
    if (!suggestion.patch || typeof suggestion.patch !== 'object' || Array.isArray(suggestion.patch)) {
      return res.status(500).json({ error: 'AI returned an invalid patch — try rephrasing the request.' });
    }
    res.json({
      explanation: suggestion.explanation || '',
      patch: suggestion.patch,
      merged: mergePatch(current, suggestion.patch),
    });
  } catch (e) {
    if (e instanceof SyntaxError) return res.status(500).json({ error: 'AI returned invalid JSON. Try again.' });
    res.status(500).json({ error: e.message });
  }
});

// Deterministic apply: merge the (possibly user-edited) patch into the LATEST
// settings.json on disk, so nothing is lost if it changed since the suggestion.
app.post('/api/settings/apply-patch', (req, res) => {
  const { patch } = req.body;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(400).json({ error: 'patch object is required' });
  }
  const settingsPath = join(claudeDir, 'settings.json');
  const merged = mergePatch(readJson(settingsPath), patch);
  writeJson(settingsPath, merged);
  res.json({ ok: true, settings: merged });
});

app.put('/api/settings', (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings object required' });
  writeJson(join(claudeDir, 'settings.json'), settings);
  res.json({ ok: true });
});

// --- API: Skills ---

// ===== AI USAGE LOG (prompt-improvement flywheel) =====
// One JSONL line per AI call, recording the DEFECT SIGNALS that already fire
// server-side (fence-strip, unescape, prose-slice recovery, JSON parse
// failures, lint gaps, eval verdicts). Every recovery firing means a meta
// prompt failed to prevent something — the health panel aggregates these so
// holes surface as counters instead of transcript-reading. Local file, no AI
// calls, zero cost.
const AI_USAGE_PATH = join(__dirname, 'claude-manager-ai-usage.jsonl');
function logAiUsage(entry) {
  try { appendFileSync(AI_USAGE_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}

app.get('/api/ai-usage/summary', (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const cutoff = Date.now() - days * 86400000;
  const groups = {};
  try {
    if (existsSync(AI_USAGE_PATH)) {
      for (const line of readFileSync(AI_USAGE_PATH, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (new Date(e.ts).getTime() < cutoff) continue;
        const key = e.promptId || e.ep || 'unknown';
        const g = groups[key] = groups[key] || { key, calls: 0, fence: 0, escape: 0, slice: 0, jsonFail: 0, lintMissing: 0, autoAdded: 0, evalScores: [], evalRevise: 0, errors: 0 };
        g.calls++;
        if (e.fence) g.fence++;
        if (e.escape) g.escape++;
        if (e.slice) g.slice++;
        if (e.jsonFail) g.jsonFail++;
        if (e.error) g.errors++;
        if (e.lintMissing) g.lintMissing += e.lintMissing;
        if (e.autoAdded) g.autoAdded += e.autoAdded;
        if (typeof e.score === 'number') g.evalScores.push(e.score);
        if (e.verdict === 'revise') g.evalRevise++;
      }
    }
  } catch {}
  res.json({
    days,
    prompts: Object.values(groups).map(g => ({
      ...g,
      evalAvg: g.evalScores.length ? +(g.evalScores.reduce((a, b) => a + b, 0) / g.evalScores.length).toFixed(1) : null,
      evalScores: undefined,
      evalCount: g.evalScores.length,
    })).sort((a, b) => b.calls - a.calls),
  });
});

// ===== TOOL-CONSISTENCY LINT =====
// The invariant our prompts teach ("every tool the body uses must be granted")
// enforced as code — DOET: constraints beat instructions. Heuristic on purpose:
// word-boundary tool names + mcp__ mentions + shell-command signals.
// ⚠ MAP-VS-TERRITORY: these tool lists are a static snapshot of Claude Code's
// tool catalog (verified 2026-07 against code.claude.com/docs/en/tools-reference).
// When Claude Code ships new prompting tools, add them here or the lint under-reports.
const LINT_PROMPTING_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'];
const LINT_READONLY_TOOLS  = ['Read', 'Grep', 'Glob']; // never prompt inside the cwd

function detectBodyTools(body) {
  const used = new Set();
  for (const t of [...LINT_PROMPTING_TOOLS, ...LINT_READONLY_TOOLS, 'Bash']) {
    if (new RegExp('\\b' + t + '\\b').test(body)) used.add(t);
  }
  (body.match(/mcp__[a-zA-Z0-9-]+(?:__[a-zA-Z0-9_-]+)?/g) || []).forEach(m => used.add(m));
  if (/```(?:bash|sh|shell|console)/.test(body) || /(?:^|\n)\s*(?:\d+\.\s+)?(?:run|execute)\b[^\n]*`[^`]+`/i.test(body)) used.add('Bash');
  return [...used];
}

function lintToolConsistency(type, content) {
  const out = { missing: [], unused: [], suggestions: [] };
  try {
    const meta = parseFrontmatter(content);
    const body = content.startsWith('---') ? content.replace(/^---\n[\s\S]*?\n---\n?/, '') : content;
    const rules = type === 'agent' ? normalizeTools(meta.tools) : splitToolRules(meta['allowed-tools']);
    const mcpServers = type === 'agent' ? normalizeTools(meta.mcpServers) : [];
    const bases = new Set(rules.map(r => String(r).replace(/\(.*$/, '').trim()));
    const used = detectBodyTools(body);
    const covered = (u) => {
      if (bases.has(u)) return true;
      if (u.startsWith('mcp__')) {
        const server = u.split('__')[1];
        return [...bases].some(g => g === 'mcp__' + server || u === g || u.startsWith(g + '__'))
          || mcpServers.includes(server);
      }
      return false;
    };
    for (const u of used) {
      if (LINT_READONLY_TOOLS.includes(u)) continue;
      if (type === 'agent' && !meta.tools) continue; // omitted tools field = inherits ALL
      if (!covered(u)) out.missing.push(u);
    }
    for (const b of bases) {
      if (LINT_READONLY_TOOLS.includes(b)) continue; // harmless extra grants
      if (!used.some(u => u === b || (b.startsWith('mcp__') && u.startsWith(b)))) out.unused.push(b);
    }
    if (out.missing.includes('Bash')) {
      // A silent blanket Bash grant is a security decision the user should make.
      out.missing = out.missing.filter(m => m !== 'Bash');
      out.suggestions.push('Body runs shell commands but grants no Bash rule — add Bash(<command> *) rules matching the exact commands the steps run.');
    }
  } catch {}
  return out;
}

// Auto-grant: after generation/improve, if the body uses tools the frontmatter
// never granted, add them (non-Bash only; single-line field values only).
function enforceToolConsistency(type, content) {
  const before = lintToolConsistency(type, content);
  const autoAdded = [];
  if (before.missing.length && content.startsWith('---')) {
    const field = type === 'agent' ? 'tools' : 'allowed-tools';
    const fmEnd = content.indexOf('\n---', 3);
    if (fmEnd !== -1) {
      const sep = type === 'agent' ? ', ' : ' ';
      const lineRe = new RegExp('(\\n' + field + ':)([^\\n]*)');
      const m = content.slice(0, fmEnd).match(lineRe);
      if (m && m[2].trim() && !m[2].trim().startsWith('>')) {
        content = content.slice(0, fmEnd).replace(lineRe, (_, a, b) => a + b + sep + before.missing.join(sep)) + content.slice(fmEnd);
        autoAdded.push(...before.missing);
      } else if (!m) {
        content = content.slice(0, fmEnd) + `\n${field}: ${before.missing.join(sep)}` + content.slice(fmEnd);
        autoAdded.push(...before.missing);
      } else {
        before.suggestions.push(`Add to ${field}: ${before.missing.join(', ')} (multiline value — not auto-edited)`);
      }
    }
  }
  const lint = lintToolConsistency(type, content);
  lint.autoAdded = autoAdded;
  lint.suggestions = [...new Set([...before.suggestions, ...lint.suggestions])];
  return { content, lint };
}

// One-click fix for the '⚠ grants incomplete' badge: runs the SAME enforcement
// the generation pipeline uses, on the file already on disk. Bash still never
// auto-granted — it stays a suggestion for the user to add explicitly.
app.post('/api/lint/resolve', (req, res) => {
  const { type, name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const paths = {
    skill:   join(claudeDir, 'skills', name, 'SKILL.md'),
    agent:   join(claudeDir, 'agents', name + '.md'),
    command: join(claudeDir, 'commands', name + '.md'),
  };
  const fp = paths[type];
  if (!fp) return res.status(400).json({ error: 'type must be skill, agent, or command' });
  if (!resolve(fp).startsWith(resolve(claudeDir) + path.sep)) return res.status(400).json({ error: 'Invalid name' });
  if (!existsSync(fp)) return res.status(404).json({ error: `${type} not found: ${name}` });
  const original = readFileSync(fp, 'utf8');
  const { content: fixed, lint } = enforceToolConsistency(type, original);
  if (fixed !== original) writeFileSync(fp, fixed, 'utf8');
  res.json({ ok: true, changed: fixed !== original, added: lint.autoAdded || [], lint });
});

app.get('/api/skills', (req, res) => {
  const skillsDir = join(claudeDir, 'skills');
  if (!existsSync(skillsDir)) return res.json([]);
  const skills = readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const skillPath = join(skillsDir, d.name, 'SKILL.md');
      const content = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : '';
      const meta = parseFrontmatter(content);
      const stat = existsSync(skillPath) ? statSync(skillPath) : null;
      return {
        name: d.name,
        description: (meta.description || '').slice(0, 120),
        trigger: meta.trigger || '',
        model: meta.model || '',
        allowedTools: splitToolRules(meta['allowed-tools']),
        disallowedTools: splitToolRules(meta['disallowed-tools']),
        lint: lintToolConsistency('skill', content),
        size: stat ? formatSize(stat.size) : '0 B',
        modified: stat ? stat.mtime.toISOString() : null,
      };
    });
  res.json(skills);
});

// IMPORTANT: this route MUST be registered before /api/skills/:name — otherwise
// Express matches "creators" as a skill name and this endpoint always 404s.
app.get('/api/skills/creators', (req, res) => {
  const creators = [];
  const seen = new Set();
  const skillsDir = join(claudeDir, 'skills');
  if (existsSync(skillsDir)) {
    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      const readEntry = (entry) => {
        const skillPath = entry.isDirectory()
          ? join(skillsDir, entry.name, 'SKILL.md')
          : join(skillsDir, entry.name);
        return existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : null;
      };
      // 1) An installed official skill-creator skill always takes priority
      for (const entry of entries) {
        const bare = entry.name.toLowerCase().replace(/\.md$/, '');
        if (bare !== 'skill-creator') continue;
        const content = readEntry(entry);
        if (!content) continue;
        creators.push({ name: 'skill-creator (Installed)', content, official: true, installed: true });
        seen.add(bare);
      }
      // 2) Other locally installed creator-like skills
      for (const entry of entries) {
        const bare = entry.name.toLowerCase().replace(/\.md$/, '');
        if (seen.has(bare)) continue;
        const content = readEntry(entry);
        if (!content) continue;
        const isCreator = /skill.?creat|creat.?skill|generat.?skill|skill.?generat|build.?skill|skill.?build|meta.?skill/i.test(bare)
          || /skill.?creat|creat.?skill|generat.?skill|meta.?skill/i.test(content.slice(0, 500));
        if (isCreator) { creators.push({ name: bare + ' (Local)', content, official: false, installed: true }); seen.add(bare); }
      }
    } catch {}
  }
  // 3) Built-in fallback methodology (always available)
  creators.push({ name: 'skill-creator (Built-in)', content: getPrompt('skill-creator-builtin'), official: true, builtin: true });
  res.json(creators);
});

app.get('/api/skills/:name', (req, res) => {
  try {
    const skillPath = safePath(join(claudeDir, 'skills'), req.params.name, 'SKILL.md');
    if (!existsSync(skillPath)) return res.status(404).json({ error: 'Skill not found' });
    res.json({ name: req.params.name, content: readFileSync(skillPath, 'utf8') });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/skills', (req, res) => {
  const { name, content } = req.body;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: 'Invalid skill name' });
  const skillsDir = join(claudeDir, 'skills');
  ensureDir(skillsDir);
  const skillDir = join(skillsDir, name);
  if (existsSync(skillDir)) return res.status(409).json({ error: 'Skill already exists' });
  mkdirSync(skillDir, { recursive: true });
  atomicWrite(join(skillDir, 'SKILL.md'), content ?? `# ${name}\n\nDescribe your skill here.\n`);
  res.status(201).json({ ok: true, name });
});

app.put('/api/skills/:name', (req, res) => {
  try {
    const skillPath = safePath(join(claudeDir, 'skills'), req.params.name, 'SKILL.md');
    ensureDir(dirname(skillPath));
    atomicWrite(skillPath, req.body.content ?? '');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/skills/:name', (req, res) => {
  try {
    const skillDir = safePath(join(claudeDir, 'skills'), req.params.name);
    if (!existsSync(skillDir)) return res.status(404).json({ error: 'Skill not found' });
    rmSync(skillDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- API: Hooks ---

const HOOK_TEMPLATE = (name) => `#!/usr/bin/env node
// ${name} — Claude Code lifecycle hook

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });
const lines = [];
rl.on('line', line => lines.push(line));
rl.on('close', () => {
  try {
    const input = JSON.parse(lines.join('\\n') || '{}');
    // TODO: implement hook logic here
    // To allow the action to proceed:
    // process.stdout.write(JSON.stringify({ continue: true }));
  } catch {}
});
`;

app.get('/api/hooks', (req, res) => {
  const hooksDir = join(claudeDir, 'hooks');
  const settingsPath = join(claudeDir, 'settings.json');
  const settings = readJson(settingsPath);
  // If settings.json exists but can't be parsed, hook config silently shows
  // as empty — surface the parse error instead of hiding it.
  let settingsError = null;
  if (existsSync(settingsPath)) {
    try { JSON.parse(readFileSync(settingsPath, 'utf8')); }
    catch (e) { settingsError = 'settings.json could not be parsed (' + e.message + ') — hook config may exist but cannot be displayed. Fix the JSON in the Settings tab.'; }
  }

  // Hook files in hooks/ — RECURSIVE (subfolders included), and per-file
  // try/catch so one unreadable entry can't blank the whole hooks tab.
  const files = [];
  if (existsSync(hooksDir)) {
    for (const full of walkFiles(hooksDir)) {
      if (!HOOK_EXTS.test(full)) continue;
      try {
        const stat = statSync(full);
        files.push({
          name: relPath(hooksDir, full),
          content: stat.size <= 512 * 1024 ? readFileSync(full, 'utf8') : '(file too large to preview)',
          size: formatSize(stat.size),
          modified: stat.mtime.toISOString(),
        });
      } catch {}
    }
  }

  // Hook/script files living ANYWHERE else in .claude — skills and plugins
  // often ship their own hooks and helper scripts.
  const elsewhere = [];
  for (const dirName of ['skills', 'agents', 'plugins', 'commands']) {
    const base = join(claudeDir, dirName);
    if (!existsSync(base)) continue;
    for (const full of walkFiles(base)) {
      if (!HOOK_EXTS.test(full)) continue;
      if (elsewhere.length >= 300) break;
      const rel = relPath(claudeDir, full);
      // marketplace catalog checkouts are not installed — skip them
      if (rel.startsWith('plugins/marketplaces/') || rel.startsWith('plugins/cache/')) continue;
      try {
        const stat = statSync(full);
        elsewhere.push({ path: rel, size: formatSize(stat.size), modified: stat.mtime.toISOString() });
      } catch {}
    }
  }

  res.json({ files, elsewhere, settings: settings.hooks || {}, settingsError });
});

const HOOK_EXTS = /\.(mjs|js|sh|py|ps1|cmd|bat)$/;
const CHMOD_EXTS = /\.(sh|py|mjs|js)$/; // Unix executable scripts

app.post('/api/hooks/files', (req, res) => {
  const { name, content } = req.body;
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name) || !HOOK_EXTS.test(name))
    return res.status(400).json({ error: 'Invalid filename. Allowed extensions: .mjs .js .sh .py .ps1 .cmd .bat' });
  const hooksDir = join(claudeDir, 'hooks');
  ensureDir(hooksDir);
  try {
    const filePath = safePath(hooksDir, name);
    if (existsSync(filePath)) return res.status(409).json({ error: 'File already exists' });
    atomicWrite(filePath, content ?? HOOK_TEMPLATE(name));
    if (CHMOD_EXTS.test(name) && process.platform !== 'win32') {
      try { execSync(`chmod +x "${filePath.replace(/"/g, '\\"')}"`, { shell: true }); } catch {}
    }
    res.status(201).json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/hooks/files/:name', (req, res) => {
  try {
    const filePath = safePath(join(claudeDir, 'hooks'), req.params.name);
    ensureDir(dirname(filePath));
    atomicWrite(filePath, req.body.content ?? '');
    if (CHMOD_EXTS.test(req.params.name) && process.platform !== 'win32') {
      try { execSync(`chmod +x "${filePath.replace(/"/g, '\\"')}"`, { shell: true }); } catch {}
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/hooks/files/:name', (req, res) => {
  try {
    const filePath = safePath(join(claudeDir, 'hooks'), req.params.name);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/hooks/settings', (req, res) => {
  const settingsPath = join(claudeDir, 'settings.json');
  const settings = readJson(settingsPath);
  settings.hooks = req.body.hooks;
  writeJson(settingsPath, settings);
  res.json({ ok: true });
});

// --- API: Plugins ---

// `claude mcp add` writes to the GLOBAL ~/.claude.json (not <claudeDir>/settings.json),
// and `claude plugin install` records plugins under settings.json enabledPlugins.
// Read all of these so installed plugins actually show up.
const globalClaudeJsonPath = () => join(homedir(), '.claude.json');
function readGlobalClaudeJson() { return readJson(globalClaudeJsonPath(), {}); }

// `claude mcp add` defaults to LOCAL scope, which stores the server under
// projects[<cwd>].mcpServers in ~/.claude.json — not top-level mcpServers.
// Collect servers from both the user scope and every project (local scope).
function collectGlobalMcpServers() {
  const globalCfg = readGlobalClaudeJson();
  const out = [];
  Object.entries(globalCfg.mcpServers || {}).forEach(([id, cfg]) =>
    out.push({ id, cfg, configFile: '~/.claude.json', scope: 'user' }));
  Object.entries(globalCfg.projects || {}).forEach(([projPath, proj]) => {
    Object.entries((proj && proj.mcpServers) || {}).forEach(([id, cfg]) =>
      out.push({ id, cfg, configFile: `~/.claude.json (local: ${projPath})`, scope: 'local' }));
  });
  return out;
}

// EVERY location Claude Code reads MCP servers from:
//   1. <claudeDir>/settings.json         (user scope)
//   2. <claudeDir>/settings.local.json   (user local overrides)
//   3. ~/.claude.json mcpServers         (user scope via `claude mcp add -s user`)
//   4. ~/.claude.json projects[*]        (local scope — `claude mcp add` default)
//   5. <project>/.mcp.json               (project scope, shared via git) — projects
//      discovered from the ~/.claude.json projects index
function collectAllMcpServers() {
  const out = [];
  const seen = new Set();
  const push = (id, cfg, configFile, scope) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, cfg: cfg || {}, configFile, scope });
  };
  const fromFile = (file, label, scope) => {
    const data = readJson(file, {});
    Object.entries(data.mcpServers || {}).forEach(([id, cfg]) => push(id, cfg, label, scope));
  };
  fromFile(join(claudeDir, 'settings.json'), 'settings.json', 'user');
  fromFile(join(claudeDir, 'settings.local.json'), 'settings.local.json', 'user');
  collectGlobalMcpServers().forEach(({ id, cfg, configFile, scope }) => push(id, cfg, configFile, scope));
  // Project-scope .mcp.json files, found via the global projects index
  const globalCfg = readGlobalClaudeJson();
  Object.keys(globalCfg.projects || {}).slice(0, 100).forEach(projPath => {
    try {
      const mcpFile = join(projPath, '.mcp.json');
      if (!existsSync(mcpFile)) return;
      const data = readJson(mcpFile, {});
      Object.entries(data.mcpServers || {}).forEach(([id, cfg]) => push(id, cfg, `.mcp.json (${projPath})`, 'project'));
    } catch {}
  });
  return out;
}

// Plugin descriptions: read marketplace manifests that `claude plugin
// marketplace add` stores on disk, so each installed plugin can show what it does.
function getPluginDescriptions() {
  const map = {};
  const mktBase = join(claudeDir, 'plugins', 'marketplaces');
  if (!existsSync(mktBase)) return map;
  let dirs = [];
  try { dirs = readdirSync(mktBase, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return map; }
  for (const d of dirs) {
    for (const mf of [join(mktBase, d.name, '.claude-plugin', 'marketplace.json'), join(mktBase, d.name, 'marketplace.json')]) {
      if (!existsSync(mf)) continue;
      const raw = readJson(mf, {});
      const mktName = raw.name || d.name;
      (raw.plugins || []).forEach(p => {
        if (!p.name) return;
        map[(p.name + '@' + mktName).toLowerCase()] = p.description || '';
        if (!(p.name.toLowerCase() in map)) map[p.name.toLowerCase()] = p.description || '';
      });
    }
  }
  return map;
}

function describeMcpServer(id, cfg) {
  const catalog = MARKETPLACE.find(m => m.id === id || (m.package || '').split('/').pop() === id);
  if (catalog) return catalog.description;
  const target = cfg.command ? `${cfg.command} ${(cfg.args || []).join(' ')}`.trim() : (cfg.url || '');
  return `${cfg.type === 'sse' || cfg.type === 'http' ? 'Remote' : 'Local'} MCP server${target ? ' — ' + target.slice(0, 80) : ''}`;
}

// Single source of truth for "what's installed" — used by /api/plugins AND
// /api/overview so their numbers can never disagree.
function listAllPlugins() {
  const pluginsFile = join(claudeDir, 'plugins', 'installed_plugins.json');
  const settings = readJson(join(claudeDir, 'settings.json'));
  const pluginData = readJson(pluginsFile, { plugins: {}, enabledPlugins: {} });
  const globalCfg = readGlobalClaudeJson();
  const descriptions = getPluginDescriptions();

  // Traditional Claude plugins: union of installed_plugins.json entries and
  // any plugin recorded in enabledPlugins (settings.json or installed_plugins.json)
  const pluginIds = new Set([
    ...Object.keys(pluginData.plugins || {}),
    ...Object.keys(pluginData.enabledPlugins || {}),
    ...Object.keys(settings.enabledPlugins || {}),
  ]);
  const result = [...pluginIds].map(id => {
    const installations = (pluginData.plugins || {})[id];
    const install = (Array.isArray(installations) ? installations[0] : installations) || {};
    const enabledInSettings = (settings.enabledPlugins || {})[id];
    const enabledInPlugins = (pluginData.enabledPlugins || {})[id];
    const base = id.split('@')[0].toLowerCase();
    return {
      id, isMcpServer: false,
      description: descriptions[id.toLowerCase()] || descriptions[base]
        || (id.includes('@') ? `Claude Code plugin from the "${id.split('@')[1]}" marketplace` : 'Claude Code plugin'),
      version: install.version || 'unknown',
      scope: install.scope || 'user',
      installedAt: install.installedAt || null,
      lastUpdated: install.lastUpdated || null,
      enabled: enabledInSettings !== undefined ? enabledInSettings : (enabledInPlugins !== false),
    };
  });

  // MCP servers from settings.json AND global ~/.claude.json
  const knownIds = new Set(result.map(p => p.id));
  collectAllMcpServers().forEach(({ id, cfg, configFile, scope }) => {
    if (knownIds.has(id)) return;
    knownIds.add(id);
    result.push({
      id, isMcpServer: true,
      description: describeMcpServer(id, cfg),
      version: null, scope,
      installedAt: null, lastUpdated: null, enabled: true,
      mcpType: cfg.type || 'stdio',
      mcpCommand: cfg.command || cfg.url || '',
      configFile,
    });
  });

  return result;
}

app.get('/api/plugins', (req, res) => {
  res.json(listAllPlugins());
});

app.delete('/api/plugins/:id/mcp', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const settingsPath = join(claudeDir, 'settings.json');
  const settings = readJson(settingsPath);
  if (settings.mcpServers?.[id]) {
    delete settings.mcpServers[id];
    writeJson(settingsPath, settings);
    return res.json({ ok: true, configFile: 'settings.json' });
  }
  const localPath = join(claudeDir, 'settings.local.json');
  const localSettings = readJson(localPath, null);
  if (localSettings?.mcpServers?.[id]) {
    delete localSettings.mcpServers[id];
    writeJson(localPath, localSettings);
    return res.json({ ok: true, configFile: 'settings.local.json' });
  }
  // Fall back to the global ~/.claude.json (where `claude mcp add` writes) —
  // both user scope (top-level mcpServers) and local scope (projects[*].mcpServers)
  const globalCfg = readGlobalClaudeJson();
  let removed = null;
  if (globalCfg.mcpServers?.[id]) {
    delete globalCfg.mcpServers[id];
    removed = '~/.claude.json';
  }
  for (const [projPath, proj] of Object.entries(globalCfg.projects || {})) {
    if (proj?.mcpServers?.[id]) {
      delete proj.mcpServers[id];
      removed = removed || `~/.claude.json (local: ${projPath})`;
    }
  }
  if (removed) {
    writeJson(globalClaudeJsonPath(), globalCfg);
    return res.json({ ok: true, configFile: removed });
  }
  return res.status(404).json({ error: 'MCP server not found' });
});

app.put('/api/plugins/:id/toggle', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const settingsPath = join(claudeDir, 'settings.json');
  const settings = readJson(settingsPath);
  const pluginData = readJson(join(claudeDir, 'plugins', 'installed_plugins.json'), { enabledPlugins: {} });
  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  // Flip from the EFFECTIVE current state (same logic the list endpoint uses),
  // otherwise the first toggle of a plugin enabled via installed_plugins.json is a no-op.
  const enabledInSettings = settings.enabledPlugins[id];
  const enabledInPlugins = (pluginData.enabledPlugins || {})[id];
  const current = enabledInSettings !== undefined ? enabledInSettings : (enabledInPlugins !== false);
  settings.enabledPlugins[id] = !current;
  writeJson(settingsPath, settings);
  res.json({ ok: true, enabled: settings.enabledPlugins[id] });
});

app.get('/api/plugins/check-updates', async (req, res) => {
  const pluginsFile = join(claudeDir, 'plugins', 'installed_plugins.json');
  const pluginData = readJson(pluginsFile, { plugins: {} });
  const ids = Object.keys(pluginData.plugins || {});

  function fetchLatest(pkg) {
    return new Promise((resolve) => {
      const url = `https://registry.npmjs.org/${pkg}/latest`;
      https.get(url, { timeout: 8000 }, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => {
          try { resolve(JSON.parse(data).version || null); }
          catch { resolve(null); }
        });
      }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
    });
  }

  const results = {};
  await Promise.all(ids.map(async (id) => {
    // id may be "@scope/pkg@1.2.3" or "pkg@1.2.3"
    const pkgName = id.replace(/@[^@/][^@]*$/, ''); // strip trailing @version
    const install = pluginData.plugins[id];
    const current = ((Array.isArray(install) ? install[0] : install) || {}).version || null;
    const latest = await fetchLatest(pkgName || id);
    results[id] = { current, latest, hasUpdate: latest && current && latest !== current };
  }));
  res.json(results);
});

app.post('/api/plugins/:id/update', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const safeId = id.replace(/"/g, '');
  exec(`claude plugin update "${safeId}"`, { timeout: 60000, shell: true }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    res.json({ ok: true, output: stdout });
  });
});

// Remove a Claude Code plugin: run the CLI uninstall (if available) and always
// clean up local records so the UI stays consistent.
app.post('/api/plugins/:id/uninstall', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const safeId = id.replace(/"/g, '');
  const cleanLocal = () => {
    try {
      const settingsPath = join(claudeDir, 'settings.json');
      const settings = readJson(settingsPath);
      if (settings.enabledPlugins && id in settings.enabledPlugins) {
        delete settings.enabledPlugins[id];
        writeJson(settingsPath, settings);
      }
      const pf = join(claudeDir, 'plugins', 'installed_plugins.json');
      const pd = readJson(pf, null);
      if (pd) {
        let touched = false;
        if (pd.plugins && id in pd.plugins) { delete pd.plugins[id]; touched = true; }
        if (pd.enabledPlugins && id in pd.enabledPlugins) { delete pd.enabledPlugins[id]; touched = true; }
        if (touched) writeJson(pf, pd);
      }
    } catch {}
  };
  if (!claudeCliAvailable) {
    cleanLocal();
    return res.json({ ok: true, output: 'Removed from local config (Claude CLI not found, so `claude plugin uninstall` was skipped).' });
  }
  exec(`claude plugin uninstall "${safeId}"`, { timeout: 60000, shell: true }, (err, stdout, stderr) => {
    cleanLocal();
    if (err && !/not (found|installed)/i.test(stderr || '')) return res.status(500).json({ error: (stderr || err.message).trim() });
    res.json({ ok: true, output: (stdout || '').trim() || 'Uninstalled.' });
  });
});

// Reinstall ("add again") a Claude Code plugin via the CLI.
app.post('/api/plugins/:id/reinstall', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const safeId = id.replace(/"/g, '');
  if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found — cannot reinstall.' });
  exec(`claude plugin install "${safeId}"`, { timeout: 90000, shell: true }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: (stderr || err.message).trim() });
    res.json({ ok: true, output: (stdout || '').trim() || 'Reinstalled.' });
  });
});

// --- API: AI Config & Skill Generation ---

app.get('/api/ai-config', (req, res) => {
  const cfg = loadConfig();
  res.json({
    claudeCli: claudeCliAvailable,
    hasOpenRouterKey: !!cfg.openRouterKey,
    openRouterModel: cfg.openRouterModel || 'anthropic/claude-sonnet-4-5'
  });
});

app.put('/api/ai-config', (req, res) => {
  const { openRouterKey, openRouterModel } = req.body;
  const cfg = loadConfig();
  if (openRouterKey !== undefined) cfg.openRouterKey = openRouterKey || '';
  if (openRouterModel) cfg.openRouterModel = openRouterModel;
  saveConfig(cfg);
  claudeCliAvailable = (() => { try { execSync('claude --version', { shell: true, stdio: 'pipe', timeout: 3000 }); return true; } catch { return false; } })();
  res.json({ ok: true, claudeCli: claudeCliAvailable });
});

app.post('/api/ai/generate-skill', async (req, res) => {
  const { prompt, provider, type = 'skill', creatorContent, hookLang, cliModel } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'prompt is required' });
  if (cliModel && !CLI_MODEL_RE.test(cliModel)) return res.status(400).json({ error: 'Invalid model name' });
  let fullPrompt;
  if (creatorContent?.trim()) {
    // If the content already ends with "Request:" (official skill-creator format), append directly.
    // NB: compare after trimEnd() WITHOUT a trailing space — trimEnd strips it.
    const endsWithRequest = creatorContent.trimEnd().endsWith('Request:');
    fullPrompt = endsWithRequest
      ? creatorContent.trimEnd() + ' ' + prompt.trim()
      : `You are generating a Claude Code ${type} using the methodology below.\n\n${creatorContent.trim()}\n\n========\nCRITICAL: Your response must be ONLY the raw file content with zero preamble or explanation.\nFor skill/agent the very first characters must be "---" (YAML frontmatter). Do NOT write anything before it.\nFor hook the very first line must be a shebang like "#!/usr/bin/env node".\nWrite markdown plainly — NEVER backslash-escape it (no \\---, no \\#) and never use HTML entities like &#x20;.\nEnsure allowed-tools (skills) or tools (agents) lists every tool the body uses, and nothing it doesn't.\nIf the request is ambiguous, implement the most common reasonable interpretation and note the assumption in the description.\n\nRequest: ${prompt.trim()}`;
  } else {
    const hookPromptMap = { '.mjs': 'hook-generate-node', '.js': 'hook-generate-node', '.py': 'hook-generate-python', '.sh': 'hook-generate-bash', '.bash': 'hook-generate-bash' };
    const promptMap = { skill: 'skill-generate', agent: 'agent-generate', command: 'command-generate', hook: (hookLang && hookPromptMap[hookLang]) || 'hook-generate-node' };
    // Hook prompts carry an {{EVENTS}} token — inject the live, doc-synced event
    // catalog (same pattern as the custom-event designer). No-op for other types.
    fullPrompt = getPrompt(promptMap[type] || 'skill-generate').replaceAll('{{EVENTS}}', BUILTIN_HOOK_EVENTS.join(', ')) + prompt.trim();
  }
  try {
    let content;
    if (provider === 'openrouter') {
      const cfg = loadConfig();
      if (!cfg.openRouterKey) return res.status(400).json({ error: 'OpenRouter API key not configured. Add it in Settings > AI Generation.' });
      content = await callOpenRouter(cfg.openRouterKey, cfg.openRouterModel || 'anthropic/claude-sonnet-4-5', '', fullPrompt);
    } else if (cliModel) {
      if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found. Use OpenRouter instead.' });
      content = await callClaudeCli(fullPrompt, cliModel);
    } else {
      if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found. Install Claude Code or use OpenRouter instead.' });
      content = await callClaudeCli(fullPrompt);
    }
    const _sig = { fence: /^```/.test(content), escape: false, slice: false };
    content = content.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();

    // Markdown types: undo chat-style escaping (\--- &#x20; …) BEFORE the fence
    // checks — otherwise the recovery regex slices at the closing fence and
    // silently amputates the frontmatter. (Hooks excluded: code legitimately
    // contains backslash sequences.)
    if (type !== 'hook') {
      const beforeUnescape = content;
      content = unescapeClaudeMarkdown(content);
      _sig.escape = beforeUnescape !== content;
    }

    // For skill/agent: strip any leading prose before the first YAML frontmatter block
    if (type === 'skill' || type === 'agent') {
      if (!content.startsWith('---')) {
        _sig.slice = true;
        const idx = content.search(/(?:^|\n)---\n/);
        if (idx !== -1) content = content.slice(idx).replace(/^\n/, '').trim();
      }
      if (!content.startsWith('---')) {
        return res.status(500).json({ error: 'Claude returned a description instead of file content. Try again or switch to OpenRouter.' });
      }
    }
    if (type === 'command') {
      // Commands are plain markdown — accept frontmatter or a heading; strip leading prose otherwise
      if (!content.startsWith('---') && !content.startsWith('#')) {
        _sig.slice = true;
        const idx = content.search(/(?:^|\n)(?:---\n|# )/);
        if (idx !== -1) content = content.slice(idx).replace(/^\n/, '').trim();
      }
      if (!content.startsWith('---') && !content.startsWith('#')) {
        return res.status(500).json({ error: 'Claude returned a description instead of command content. Try again or switch to OpenRouter.' });
      }
    }
    if (type === 'hook') {
      const validHook = content.startsWith('#!/usr/bin/env node') || content.startsWith('#!/usr/bin/env python')
        || content.startsWith('#!/usr/bin/env bash') || content.startsWith('#!/bin/bash')
        || content.startsWith('#!/usr/bin/env sh')   || content.startsWith('#!/usr/bin/env pwsh')
        || content.includes('readline') || content.includes('sys.stdin') || content.includes('$(cat)');
      if (!validHook) return res.status(500).json({ error: 'Claude returned a description instead of hook code. Try again or switch to OpenRouter.' });
    }

    // Enforcement layer: even when the user (or the model) forgot tool grants,
    // derive them from the generated body and add them (Bash stays a suggestion).
    let lint;
    if (type !== 'hook') ({ content, lint } = enforceToolConsistency(type, content));

    logAiUsage({
      ep: 'generate', type, provider: provider === 'openrouter' ? 'openrouter' : 'claude-cli',
      promptId: creatorContent?.trim() ? 'skill-creator' : (type === 'hook' ? 'hook-generate' : type + '-generate'),
      model: provider === 'openrouter' ? undefined : (cliModel || CLI_GEN_MODEL),
      fence: _sig.fence, escape: _sig.escape, slice: _sig.slice,
      lintMissing: lint?.missing?.length || 0, autoAdded: lint?.autoAdded?.length || 0,
      outLen: content.length,
    });
    res.json({ content, type, lint });
  } catch (e) {
    logAiUsage({ ep: 'generate', type, error: true });
    res.status(500).json({ error: e.message });
  }
});

// --- API: Skill creators + Improve ---

// Official Anthropic skill-creator methodology
// Source: github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md
// Extracted: skill-writing guide sections relevant to one-shot generation
const OFFICIAL_SKILL_CREATOR_CONTENT = `---
name: skill-creator
description: >
  Official Anthropic skill-creator methodology. Use when creating a new Claude Code skill
  from scratch. Write SKILL.md frontmatter + body following the official guide.
---

# Official Skill-Creator Methodology (Anthropic)

## Frontmatter Fields

- **name**: kebab-case identifier. Becomes the /name slash command.
- **description**: THIS IS THE PRIMARY TRIGGERING MECHANISM. Include BOTH what the skill does AND specific contexts for when to use it. Make descriptions slightly "pushy" — instead of "Builds a dashboard", write "Builds a dashboard. Use this whenever the user mentions dashboards, data visualization, or wants to display any kind of data, even if they don't explicitly say 'dashboard'." Claude tends to under-trigger; a pushy description corrects this.
- **compatibility**: Required tools or dependencies (optional, only if needed).

## Anatomy of a Skill

\`\`\`
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    — Executable code for deterministic/repetitive tasks
    ├── references/ — Docs loaded into context as needed
    └── assets/     — Files used in output (templates, icons, fonts)
\`\`\`

## Progressive Disclosure

Skills use a three-level loading system:
1. **Metadata** (name + description) — Always in context (~100 words)
2. **SKILL.md body** — In context whenever skill triggers (<500 lines ideal)
3. **Bundled resources** — Loaded as needed (unlimited)

Key patterns:
- Keep SKILL.md under 500 lines. If approaching the limit, add hierarchy with clear pointers.
- For large reference files (>300 lines), include a table of contents.
- When a skill supports multiple domains, organize by variant with a references/ folder.

## Writing the SKILL.md Body

1. **First line**: One sentence stating what this skill does and its output.
2. **Intent capture**: What it enables Claude to do, when it triggers, expected output format.
3. **Steps**: 3–7 numbered items (Miller's Law). Each step is complete and actionable.
4. **Output format**: ALWAYS show the exact output with a realistic example so the user sees exactly what to expect (Humphrey: seeing = understanding).
5. **Edge cases**: One short paragraph at the end. No more.

## Writing Style

- Use imperative form in instructions.
- Explain the **why** behind instructions instead of heavy-handed "ALWAYS"/"NEVER". LLMs respond better to understood reasoning than rigid rules.
- Use theory of mind: make the skill general, not narrow to examples.
- Remove anything that doesn't pull its weight (Occam).
- Write a draft, then read it with fresh eyes and improve it.

## Defining Output Formats

\`\`\`markdown
## Report structure
ALWAYS use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
\`\`\`

## Examples Pattern

\`\`\`markdown
## Commit message format
**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
\`\`\`

## Description Quality Checklist

- Does it name the skill AND say when to use it?
- Does it include specific trigger phrases a real user would type?
- Is it slightly "pushy" to avoid under-triggering?
- Would someone reading only the description know whether to use this skill right now?

---

## Claude Code Additions (app addendum — NOT part of the original methodology)

Claude Code extends the standard with frontmatter fields the methodology above predates. Use them:
- when_to_use: trigger phrases a real user would type (appended to description in the skill listing).
- argument-hint: "[arg]" placeholder if the skill takes arguments; the body may use $ARGUMENTS.
- allowed-tools: pre-approve the EXACT tools/commands the body uses, e.g. Read Edit Bash(git add *).
  CONSISTENCY RULE: every tool the body uses must be listed, and every listed rule must be used —
  a mismatch causes permission prompts at runtime.
- disable-model-invocation: true for side-effectful skills only the user should trigger.
- model / context: fork + agent: — run on a specific model or in a forked subagent.

Context provided with the request (tech stack, domain, MCPs) describes the user's ENVIRONMENT —
hardcode it only when the skill's purpose demands it; reference MCP tools conditionally with a
built-in fallback (Grep/Glob/Bash).

Now produce the SKILL.md for the following request.

OUTPUT CONTRACT — your response is saved to disk verbatim, so:
- Output ONLY the raw file content, starting with "---" (YAML frontmatter). No explanation, no code fences.
- Write characters plainly — NEVER backslash-escape markdown (no \\---, no \\#, no \\_) and never use HTML entities like &#x20;.
If the request is ambiguous, implement the most common reasonable interpretation and record the assumption in the description.

PRIORITY when constraints conflict: 1) this output contract  2) valid YAML/markdown syntax  3) the consistency rule  4) content quality  5) style.
Final check before responding: output starts and ends correctly, every tool the body uses is granted (and nothing more), required fields present — fix silently, then output only the file.

Request: `;


const IMPROVE_PROMPT_TEMPLATE = `You are an expert Claude Code {{TYPE}} author improving an existing {{TYPE}}.

Principles to apply:
{{PRINCIPLES}}

Method (Kidlin: name the problem before solving it):
1. Internally identify the 2-3 weakest points of the original (vague triggers?
   untestable steps? missing output example? no failure handling?).
2. Rewrite to fix exactly those. Preserve everything that already works — the
   name, working steps, and frontmatter fields that still serve (Falkland:
   change nothing you don't have to). Improvement is not reinvention.

{{FEEDBACK}}{{VALIDATION}}

ORIGINAL {{TYPE_UPPER}} TO IMPROVE:
`;

// Type-aware principles: "trigger phrases" and "output examples" are meaningless
// for a hook; hook laws are meaningless for a skill.
const IMPROVE_PRINCIPLES = {
  hook: `- Fail-open: ALL logic inside try/catch, exit 0 in the catch — a crashing hook must never block Claude.
- Stop guard: stop_hook_active checked before any work.
- Murphy: guard every stdin field access; side effects get their own try/catch; never log secrets.
- Precision: exit 0 immediately on non-match; detect exactly one condition.
- Kidlin: the filename and top comment state exactly what it prevents/produces.`,
  default: `- Pareto: clear trigger phrases + concrete numbered steps = 80% of value. Maximise these.
- Occam: cut anything the user won't miss (vague intros, redundant steps, filler sentences).
- Steps stay atomic and verifiable; merge overlapping ones; split only if a step is secretly two actions.
- Kidlin: if a step can't be written simply, rewrite it until it can.
- Humphrey: show a realistic output example so the user sees exactly what they'll get.`,
};

const IMPROVE_PROMPT = (type, feedback, original = '') => {
  // Type-aware defaults: "sharpen trigger phrases" is meaningless for a hook.
  const bestPractices = type === 'hook'
    ? 'Apply best practices: verify FAIL-OPEN (all logic in try/catch, exit 0 in the catch), the stop_hook_active guard, defensive stdin field access, precise detection with an immediate exit 0 on non-match, and no secrets in logs.\n\n'
    : 'Apply best practices: sharpen trigger phrases, tighten steps (max 7), remove filler, improve the output example to be concrete and realistic.\n\n';
  const feedbackSection = feedback
    ? `User feedback (what needs fixing/improving):\n${feedback}\n\nIncorporate this feedback precisely.\n\n`
    : bestPractices;
  // Language-aware: an improved Python/Bash hook must keep ITS shebang, not be
  // corrupted into a Node one.
  const firstLine = (original.split('\n', 1)[0] || '').trim();
  const shebang = firstLine.startsWith('#!') ? firstLine : '#!/usr/bin/env node';
  const validation = (type === 'skill' || type === 'agent')
    ? 'Also run the CONSISTENCY CHECK as part of the improvement: every tool the body uses must appear in allowed-tools (agents: tools, plus mcp__ servers in mcpServers), and every granted rule must be used by some step — fix any mismatch.\n'
      + 'Output ONLY the raw improved file content. Start with "---" (YAML frontmatter). Write markdown plainly — never backslash-escape it. No explanation.'
    : `Output ONLY the raw improved code. Start with "${shebang}". No explanation.`;
  return getPrompt('improve')
    .replaceAll('{{TYPE_UPPER}}', type.toUpperCase())
    .replaceAll('{{TYPE}}', type)
    .replaceAll('{{PRINCIPLES}}', IMPROVE_PRINCIPLES[type] || IMPROVE_PRINCIPLES.default)
    .replaceAll('{{FEEDBACK}}', feedbackSection)
    .replaceAll('{{VALIDATION}}', validation);
};

// ── Bounded self-eval ──
// Evaluator = the INVERSION checklist (what guarantees a bad artifact) + the
// deterministic lint as ground truth. HARD CAP: MAX_EVAL_ROUNDS evaluations and
// ONE revision — at most 3 model calls per request. It can never loop.
const MAX_EVAL_ROUNDS = 2;

const EVAL_ARTIFACT_PROMPT_TEMPLATE = `You are a strict Claude Code {{TYPE}} artifact evaluator. Judge the artifact below against its original request. Do not rewrite it — judge it.

INVERSION CHECKLIST — the {{TYPE}} FAILS if any of these are true:
- Environment context (tech stack, MCP names) hardcoded where the purpose doesn't demand it
- Tools the body uses but never grants — see LINT below, it is deterministic ground truth — or grants nothing uses
- Steps with no observable/verifiable result
- Vague trigger phrases no real user would type (skills/agents/commands)
- Escaped markdown (\\---, &#x20;) or code fences around the file
- Invented Claude Code capabilities, frontmatter fields, or events
- Scope beyond what the request asked for

Score 0-10 (10 = ship as-is). verdict "pass" requires score >= 8 AND an empty LINT "missing" list.

Output ONLY raw JSON — no prose, no fences. The very first character of your response must be '{' and the very last must be '}'.
{"score": <0-10>, "verdict": "pass" | "revise", "issues": [{"severity": "high"|"medium"|"low", "issue": "what is wrong", "fix": "one concrete instruction that fixes it"}]}
`;

app.post('/api/ai/eval-artifact', async (req, res) => {
  const { type = 'skill', request = '', content, provider, cliModel } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
  if (cliModel && !CLI_MODEL_RE.test(cliModel)) return res.status(400).json({ error: 'Invalid model name' });

  const callModel = async (prompt) => {
    if (provider === 'openrouter') {
      const cfg = loadConfig();
      if (!cfg.openRouterKey) throw Object.assign(new Error('OpenRouter API key not configured.'), { status: 400 });
      return callOpenRouter(cfg.openRouterKey, cfg.openRouterModel || 'anthropic/claude-sonnet-4-5', '', prompt);
    }
    if (!claudeCliAvailable) throw Object.assign(new Error('Claude CLI not found. Use OpenRouter instead.'), { status: 400 });
    return callClaudeCli(prompt, cliModel || undefined);
  };

  const evalOnce = async (current) => {
    const lint = type === 'hook' ? { missing: [], unused: [], suggestions: [] } : lintToolConsistency(type, current);
    const prompt = getPrompt('eval-artifact').replaceAll('{{TYPE}}', type)
      + '\nLINT (deterministic ground truth): ' + JSON.stringify(lint)
      + '\n\nORIGINAL REQUEST:\n' + String(request).slice(0, 4000)
      + '\n\nARTIFACT TO EVALUATE:\n' + current;
    const raw = (await callModel(prompt)).replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const r = JSON.parse(raw);
    return {
      score: Math.max(0, Math.min(10, Number(r.score) || 0)),
      verdict: r.verdict === 'pass' ? 'pass' : 'revise',
      issues: Array.isArray(r.issues) ? r.issues.slice(0, 10) : [],
    };
  };

  try {
    const rounds = [];
    let current = content;
    let changed = false;
    for (let i = 0; i < MAX_EVAL_ROUNDS; i++) {
      const round = await evalOnce(current);
      rounds.push(round);
      if (round.verdict === 'pass' || i === MAX_EVAL_ROUNDS - 1) break;
      // ONE bounded revision, driven by the evaluator's own fix instructions
      const feedback = round.issues.map(x => `[${x.severity}] ${x.issue} — fix: ${x.fix}`).join('\n') || 'Fix the lint findings.';
      let improved = await callModel(IMPROVE_PROMPT(type, feedback, current) + current);
      improved = improved.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
      if (type !== 'hook' && improved) {
        improved = unescapeClaudeMarkdown(improved);
        ({ content: improved } = enforceToolConsistency(type, improved));
      }
      if (improved && improved !== current) { current = improved; changed = true; rounds.push({ revised: true }); }
    }
    const evals = rounds.filter(r => r.score !== undefined);
    const final = evals[evals.length - 1];
    logAiUsage({ ep: 'eval', promptId: 'eval-artifact', type, score: final.score, verdict: final.verdict, revised: changed, capped: evals.length >= MAX_EVAL_ROUNDS && final.verdict !== 'pass' });
    res.json({
      content: current, changed, rounds,
      score: final.score, verdict: final.verdict,
      capped: evals.length >= MAX_EVAL_ROUNDS && final.verdict !== 'pass',
    });
  } catch (e) {
    if (e instanceof SyntaxError) {
      logAiUsage({ ep: 'eval', promptId: 'eval-artifact', type, jsonFail: true });
      return res.status(500).json({ error: 'Evaluator returned invalid JSON. Try again.' });
    }
    res.status(e.status || 500).json({ error: e.message });
  }
});

// (The /api/skills/creators route is registered above /api/skills/:name — see Skills section.)

app.post('/api/ai/improve-skill', async (req, res) => {
  const { type = 'skill', content, feedback, provider } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
  const fullPrompt = IMPROVE_PROMPT(type, feedback?.trim() || null, content) + content.trim();
  try {
    let improved;
    if (provider === 'openrouter') {
      const cfg = loadConfig();
      if (!cfg.openRouterKey) return res.status(400).json({ error: 'OpenRouter API key not configured.' });
      improved = await callOpenRouter(cfg.openRouterKey, cfg.openRouterModel || 'anthropic/claude-sonnet-4-5', '', fullPrompt);
    } else {
      if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found.' });
      improved = await callClaudeCli(fullPrompt);
    }
    const hadFence = /^```/.test(improved);
    improved = improved.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
    let hadEscape = false;
    if (type !== 'hook') { const b = improved; improved = unescapeClaudeMarkdown(improved); hadEscape = b !== improved; }
    let lint;
    if (type !== 'hook') ({ content: improved, lint } = enforceToolConsistency(type, improved));
    logAiUsage({ ep: 'improve', promptId: 'improve', type, fence: hadFence, escape: hadEscape, lintMissing: lint?.missing?.length || 0, autoAdded: lint?.autoAdded?.length || 0 });
    res.json({ content: improved, type, lint });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API: Commands ---

app.get('/api/commands', (req, res) => {
  const commandsDir = join(claudeDir, 'commands');
  if (!existsSync(commandsDir)) return res.json([]);
  const commands = readdirSync(commandsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = readFileSync(join(commandsDir, f), 'utf8');
      const stat = statSync(join(commandsDir, f));
      return { name: f.replace(/\.md$/, ''), content, lint: lintToolConsistency('command', content), size: formatSize(stat.size), modified: stat.mtime.toISOString() };
    });
  res.json(commands);
});

app.post('/api/commands', (req, res) => {
  const { name, content } = req.body;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: 'Invalid command name' });
  const commandsDir = join(claudeDir, 'commands');
  ensureDir(commandsDir);
  try {
    const filePath = safePath(commandsDir, name + '.md');
    if (existsSync(filePath)) return res.status(409).json({ error: 'Command already exists' });
    atomicWrite(filePath, content ?? `# /${name}\n\nDescribe this command.\n`);
    res.status(201).json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/commands/:name', (req, res) => {
  try {
    const commandsDir = join(claudeDir, 'commands');
    ensureDir(commandsDir);
    const filePath = safePath(commandsDir, req.params.name + '.md');
    atomicWrite(filePath, req.body.content ?? '');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/commands/:name', (req, res) => {
  try {
    const filePath = safePath(join(claudeDir, 'commands'), req.params.name + '.md');
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- API: Keybindings ---

app.get('/api/keybindings', (req, res) => {
  const filePath = join(claudeDir, 'keybindings.json');
  const exists = existsSync(filePath);
  res.json({ content: exists ? readFileSync(filePath, 'utf8') : '', exists });
});

app.put('/api/keybindings', (req, res) => {
  const { content } = req.body;
  try { JSON.parse(content); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  atomicWrite(join(claudeDir, 'keybindings.json'), content);
  res.json({ ok: true });
});

// --- AI: Workflow plan prompt (lightweight — names/types/descriptions, NO content) ---

const WORKFLOW_PLAN_PROMPT = `You are a Claude Code workflow architect.
Output ONLY raw JSON — no prose, no markdown fences, no explanation.
The very first character of your response must be '{' and the very last must be '}'.

Shape:
{
  "name": "kebab-case-name",
  "title": "Human Readable Title",
  "description": "One sentence — what this workflow accomplishes and who benefits.",
  "setupGuide": ["plain text step 1", "plain text step 2", "plain text step 3"],
  "components": [
    { "type": "skill"|"agent"|"hook"|"command", "name": "kebab-case-name", "description": "One sentence — this component's specific role.", "event": "hooks ONLY: the lifecycle event to wire to (PreToolUse, PostToolUse, PostToolUseFailure, Stop, SessionStart, SessionEnd, UserPromptSubmit, SubagentStop, PreCompact, Notification...)", "matcher": "hooks ONLY: tool-name regex for PreToolUse/PostToolUse (e.g. \\"Bash\\", \\"Write|Edit\\"), empty string otherwise" }
  ]
}

RULES (no exceptions):
- components array: ONLY name/type/description (+ event/matcher for hooks) — NO content field
- EVERY hook component MUST include "event" so it can be wired automatically
- Pareto: pick the vital-few components that deliver 80% of the value
- Occam: if 2 components cover the goal, don't add a third
- Miller: max 6 components total
- All names: lowercase-hyphens only, unique within the workflow
- setupGuide: 3–5 concise plain-text steps that explain how to activate and use the workflow
- The LAST setupGuide step MUST tell the user how to VERIFY it works (a command to run
  or behavior to observe) — a workflow you can't verify isn't finished (Gilbert)
`;

app.post('/api/ai/generate-workflow-plan', async (req, res) => {
  const { goal, context, provider } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: 'goal is required' });
  const contextBlock = context?.trim() ? `\nAdditional context:\n${context.trim()}\n` : '';
  let extras = '';
  try { extras = await buildAiContextBlocks(req.body); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  const fullPrompt = getPrompt('workflow-plan') + contextBlock + extras + '\nGoal: ' + goal.trim();
  try {
    let raw;
    if (provider === 'openrouter') {
      const cfg = loadConfig();
      if (!cfg.openRouterKey) return res.status(400).json({ error: 'OpenRouter API key not configured.' });
      raw = await callOpenRouter(cfg.openRouterKey, cfg.openRouterModel || 'anthropic/claude-sonnet-4-5', '', fullPrompt);
    } else {
      if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found. Use OpenRouter instead.' });
      raw = await callClaudeCli(fullPrompt);
    }
    const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const plan = JSON.parse(json);
    if (!Array.isArray(plan.components) || !plan.components.length) {
      return res.status(500).json({ error: 'AI returned an invalid plan — try rephrasing your goal.' });
    }
    logAiUsage({ ep: 'workflow-plan', promptId: 'workflow-plan', fence: /^```/.test(raw) });
    res.json(plan);
  } catch (e) {
    if (e instanceof SyntaxError) {
      logAiUsage({ ep: 'workflow-plan', promptId: 'workflow-plan', jsonFail: true });
      return res.status(500).json({ error: 'AI returned invalid JSON. Try again.' });
    }
    res.status(500).json({ error: e.message });
  }
});

// --- AI: Compose workflow from ALREADY-INSTALLED resources ---

function collectInventory() {
  const inv = { skills: [], agents: [], hooks: [], commands: [] };
  const readDesc = (p) => { try { return (parseFrontmatter(readFileSync(p, 'utf8')).description || '').replace(/\s+/g, ' ').slice(0, 150); } catch { return ''; } };
  const skillsDir = join(claudeDir, 'skills');
  if (existsSync(skillsDir)) {
    for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      inv.skills.push({ name: d.name, description: readDesc(join(skillsDir, d.name, 'SKILL.md')) });
    }
  }
  const agentsDir = join(claudeDir, 'agents');
  if (existsSync(agentsDir)) {
    for (const full of walkFiles(agentsDir)) {
      if (!full.endsWith('.md')) continue;
      inv.agents.push({ name: relPath(agentsDir, full).replace(/\.md$/, ''), description: readDesc(full) });
    }
  }
  const hooksDir = join(claudeDir, 'hooks');
  if (existsSync(hooksDir)) {
    // Hooks need more than a filename: the AI otherwise guesses what each does
    // and may instruct wiring a hook that is already wired.
    const hookSettings = readJson(join(claudeDir, 'settings.json')).hooks || {};
    for (const full of walkFiles(hooksDir)) {
      if (!HOOK_EXTS.test(full)) continue;
      const name = relPath(hooksDir, full);
      let description = '';
      try {
        const firstComment = readFileSync(full, 'utf8').split('\n').slice(0, 6)
          .find(l => /^\s*(\/\/|#)(?!!)/.test(l));
        if (firstComment) description = firstComment.replace(/^\s*(\/\/|#)\s*/, '').replace(/\s+/g, ' ').slice(0, 120);
      } catch {}
      const wiredTo = Object.entries(hookSettings)
        .filter(([, arr]) => JSON.stringify(arr).includes(name))
        .map(([evt]) => evt);
      inv.hooks.push({ name, description, wiredTo });
    }
  }
  const commandsDir = join(claudeDir, 'commands');
  if (existsSync(commandsDir)) {
    for (const f of readdirSync(commandsDir).filter(f => f.endsWith('.md'))) {
      inv.commands.push({ name: f.replace(/\.md$/, ''), description: readDesc(join(commandsDir, f)) });
    }
  }
  return inv;
}

// Installed MCP servers + plugins (name/kind/description) — offered to the AI
// as capabilities it can leverage when designing workflows.
function collectMcpAndPlugins() {
  const settings = readJson(join(claudeDir, 'settings.json'));
  const descs = getPluginDescriptions();
  const out = [];
  collectAllMcpServers().forEach(({ id, cfg }) =>
    out.push({ name: id, kind: 'mcp', description: describeMcpServer(id, cfg) }));
  const pluginData = readJson(join(claudeDir, 'plugins', 'installed_plugins.json'), {});
  new Set([...Object.keys(settings.enabledPlugins || {}), ...Object.keys(pluginData.plugins || {})]).forEach(id => {
    out.push({ name: id, kind: 'plugin', description: descs[id.toLowerCase()] || descs[id.split('@')[0].toLowerCase()] || 'Claude Code plugin' });
  });
  return out;
}

// Optional AI context: user-selected MCP/plugin references and a fetched
// reference link. Throws { status: 400 } errors for invalid/unreachable URLs.
async function buildAiContextBlocks({ mcpRefs, referenceUrl } = {}) {
  const blocks = [];
  if (Array.isArray(mcpRefs) && mcpRefs.length) {
    const all = collectMcpAndPlugins();
    const chosen = mcpRefs.map(name => all.find(x => x.name === name) || { name, kind: 'mcp', description: '' });
    blocks.push('AVAILABLE MCP SERVERS / PLUGINS (user-selected environment context):\n'
      + chosen.map(x => `- ${x.name} (${x.kind})${x.description ? ': ' + x.description : ''}`).join('\n')
      + '\nUse their capabilities to inform the design, but reference their tools CONDITIONALLY with a built-in fallback ("if mcp__<server> is unavailable, use Grep/Glob/Bash equivalents"). Never make a component unusable without them unless the goal is inherently about that server.');
  }
  if (referenceUrl?.trim()) {
    let u;
    try { u = new URL(referenceUrl.trim()); } catch { throw Object.assign(new Error('Invalid reference URL'), { status: 400 }); }
    if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Reference URL must be http(s)'), { status: 400 });
    const text = await fetchTextUrl(u.href);
    if (!text) throw Object.assign(new Error('Could not fetch the reference URL (' + u.href + '). Check the link and try again.'), { status: 400 });
    blocks.push(`REFERENCE EXAMPLE (fetched from ${u.href} — the user wants the workflow to take inspiration from this; mirror its structure, conventions, or format where sensible):\n`
      + text.slice(0, 8000));
  }
  return blocks.length ? '\n\n' + blocks.join('\n\n') : '';
}

const COMPOSE_PROMPT = `You are a Claude Code workflow architect. The user wants a workflow.
Decide whether it can be composed from the ALREADY-INSTALLED resources in the inventory below.
Prefer reusing existing resources; only propose new ones when nothing installed fits.

Output ONLY raw JSON — no prose, no markdown fences. The very first character of
your response must be '{' and the very last must be '}'.
{
  "feasible": "yes" | "partial" | "no",
  "summary": "2-3 sentences: how the workflow works using existing resources, and what gaps remain.",
  "components": [ { "type": "skill" | "agent" | "hook" | "command", "name": "EXACT name from the inventory", "role": "one sentence: its job in this workflow" } ],
  "missing": [ { "type": "skill" | "agent" | "hook" | "command", "name": "suggested-kebab-name", "description": "one sentence: what needs to be created" } ],
  "setupGuide": ["plain-text step 1", "step 2", "step 3"]
}

Rules:
- components MUST use exact names from the inventory — never invent installed resources.
- missing lists only genuinely absent pieces. Max 6 components + 4 missing.
- If hooks must be wired to lifecycle events (PreToolUse etc.), explain in setupGuide.
- Hook inventory entries carry "wiredTo" (events they are ALREADY active on) — never
  instruct wiring a hook to an event it is already wired to.
- The LAST setupGuide step MUST tell the user how to VERIFY the workflow works
  (a command to run or behavior to observe).
- "no" is a valid, honest answer (Falkland). If nothing installed genuinely fits,
  say feasible:"no" with an empty components array — never force a composition
  to look helpful.
`;

app.post('/api/ai/compose-workflow', async (req, res) => {
  const { goal, provider } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: 'goal is required' });
  const inventory = collectInventory();
  const total = inventory.skills.length + inventory.agents.length + inventory.hooks.length + inventory.commands.length;
  if (!total) return res.status(400).json({ error: 'Nothing is installed yet — add some skills, agents, hooks, or commands first, or use "Create with AI" to generate a full workflow from scratch.' });

  let extras = '';
  try { extras = await buildAiContextBlocks(req.body); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  const fullPrompt = getPrompt('compose-workflow')
    + '\nINVENTORY OF INSTALLED RESOURCES:\n' + JSON.stringify(inventory, null, 1)
    + extras
    + '\n\nDesired workflow: ' + goal.trim();
  try {
    let raw;
    if (provider === 'openrouter') {
      const cfg = loadConfig();
      if (!cfg.openRouterKey) return res.status(400).json({ error: 'OpenRouter API key not configured. Add it in Settings > AI Generation.' });
      raw = await callOpenRouter(cfg.openRouterKey, cfg.openRouterModel || 'anthropic/claude-sonnet-4-5', '', fullPrompt);
    } else {
      if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found. Use OpenRouter instead.' });
      raw = await callClaudeCli(fullPrompt);
    }
    const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const plan = JSON.parse(json);

    // Validate: every referenced component must actually be installed;
    // anything that isn't gets moved into "missing" so the UI never lies.
    const installed = {
      skill:   new Set(inventory.skills.map(x => x.name.toLowerCase())),
      agent:   new Set(inventory.agents.map(x => x.name.toLowerCase())),
      hook:    new Set(inventory.hooks.map(x => x.name.toLowerCase().replace(/\.[^.]+$/, ''))),
      command: new Set(inventory.commands.map(x => x.name.toLowerCase())),
    };
    const components = [];
    const missing = Array.isArray(plan.missing) ? plan.missing : [];
    for (const c of (Array.isArray(plan.components) ? plan.components : [])) {
      const nm = String(c.name || '').toLowerCase().replace(/\.[^.]+$/, '');
      if (installed[c.type]?.has(nm)) components.push({ ...c, exists: true });
      else missing.push({ type: c.type, name: c.name, description: c.role || 'Proposed by the AI but not installed.' });
    }
    const feasible = components.length && !missing.length ? 'yes' : components.length ? 'partial' : 'no';
    logAiUsage({ ep: 'compose', promptId: 'compose-workflow', fence: /^```/.test(raw) });
    res.json({
      feasible: plan.feasible && ['yes', 'partial', 'no'].includes(plan.feasible) ? (missing.length && plan.feasible === 'yes' ? 'partial' : plan.feasible) : feasible,
      summary: plan.summary || '',
      components, missing,
      setupGuide: Array.isArray(plan.setupGuide) ? plan.setupGuide : [],
      inventoryCounts: { skills: inventory.skills.length, agents: inventory.agents.length, hooks: inventory.hooks.length, commands: inventory.commands.length },
    });
  } catch (e) {
    if (e instanceof SyntaxError) {
      logAiUsage({ ep: 'compose', promptId: 'compose-workflow', jsonFail: true });
      return res.status(500).json({ error: 'AI returned invalid JSON. Try again or rephrase the goal.' });
    }
    res.status(500).json({ error: e.message });
  }
});

// --- AI: Workflow & Explain system prompts ---

const EXPLAIN_SYSTEM_PROMPT = `You are a Claude Code expert helping developers quickly understand configuration artifacts.

Respond using ONLY these emoji-headed sections (omit any that don't apply):

📌 In plain English
One sentence: what real problem does this solve, in plain everyday terms. No jargon.

⚙️ How it works
Numbered steps (2–6) showing the exact execution flow. Be concrete and specific.

🎯 When to use this
1–2 sentences on the ideal scenario or trigger condition.

💡 How to trigger / activate
Concrete: file path, slash command, event name, YAML field, CLI flag. Use \`code ticks\`.

⚠️ Watch out for
Only include if there is a genuine gotcha. Skip entirely if none.

Rules:
- Under 260 words total
- Use \`code ticks\` for filenames, commands, event names, field names
- No filler ("This artifact", "In summary", "Essentially", "Note that")
- If given only a name + description (no source code), explain based on what that implies

`;

// NOTE (first-principles deletion): the one-shot /api/ai/generate-workflow
// endpoint and its WORKFLOW_SYSTEM_PROMPT were removed. They generated skill/
// hook content inline with a WEAKER summary of the real per-type prompts (no
// Five Laws, thin frontmatter rules) and no UI ever called them — the workflow
// wizard uses /api/ai/generate-workflow-plan + per-type /api/ai/generate-skill,
// which is now the only architecture.

app.post('/api/ai/explain', async (req, res) => {
  const { content, type, provider } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
  const fullPrompt = getPrompt('explain') + `[Type: ${type || 'unknown'}]\n\n${content.trim()}`;
  try {
    let result;
    if (provider === 'openrouter') {
      const cfg = loadConfig();
      if (!cfg.openRouterKey) return res.status(400).json({ error: 'OpenRouter API key not configured.' });
      result = await callOpenRouter(cfg.openRouterKey, cfg.openRouterModel || 'anthropic/claude-sonnet-4-5', '', fullPrompt);
    } else {
      if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found. Use OpenRouter instead.' });
      result = await callClaudeCli(fullPrompt);
    }
    res.json({ explanation: result.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Marketplace: multi-source helpers ---

const _mktCache = {};
const MKT_TTL   = 5 * 60 * 1000;

function getMarketplaceSources() {
  const cfg = loadConfig();
  return [
    { id: 'official', name: 'Official (Curated)', type: 'builtin', enabled: true,                       icon: '🏛️' },
    { id: 'npm-mcp',  name: 'NPM MCP Registry',  type: 'npm',     enabled: cfg.npmSourceEnabled !== false, icon: '📦' },
    ...(cfg.marketplaceSources || []),
  ];
}

function fetchJsonUrl(url) {
  return new Promise(resolve => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'claude-manager/1.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function cachedFetch(key, fn) {
  const e = _mktCache[key];
  if (e && Date.now() - e.ts < MKT_TTL) return e.data;
  const data = await fn();
  _mktCache[key] = { data: data || [], ts: Date.now() };
  return _mktCache[key].data;
}

async function fetchNpmSource() {
  const result = await fetchJsonUrl('https://registry.npmjs.org/-/v1/search?text=mcp-server+modelcontextprotocol&size=50');
  if (!result?.objects) return [];
  const officialPkgs = new Set(MARKETPLACE.map(p => p.package));
  return result.objects.map(o => o.package).filter(p => p.name && !officialPkgs.has(p.name)).map(p => ({
    id:          'npm-' + p.name.replace(/[^a-z0-9]/gi, '-'),
    name:        p.name,
    description: p.description || 'MCP server package',
    package:     p.name,
    category:    p.name.startsWith('@modelcontextprotocol/') ? 'Official' : 'NPM',
    author:      p.publisher?.username || (p.author && (typeof p.author === 'string' ? p.author : p.author.name)) || 'Community',
    official:    p.name.startsWith('@modelcontextprotocol/'),
    installCmd:  `claude mcp add ${p.name.split('/').pop()} -- npx -y ${p.name}`,
    source: 'npm-mcp', sourceIcon: '📦', sourceName: 'NPM MCP Registry',
  }));
}

async function fetchCustomSource(src) {
  const raw = await fetchJsonUrl(src.url);
  if (!raw) return [];
  const list = raw.plugins || raw.servers || raw.packages || (Array.isArray(raw) ? raw : []);
  // Claude Code plugin marketplace support (.claude-plugin/marketplace.json):
  // entries have a `source` field but no npm package / MCP command, so we must
  // build a `claude plugin marketplace add` + `claude plugin install` command.
  const marketplaceName = typeof raw.name === 'string' ? raw.name.trim() : '';
  let marketplaceRef = src.url;
  const gh = src.url.match(/(?:raw\.githubusercontent\.com|github\.com)\/([^/]+)\/([^/]+)/);
  if (gh) marketplaceRef = `${gh[1]}/${gh[2]}`;
  return list.map(p => {
    const slug = (p.id || p.name || Math.random().toString(36).slice(2));
    const isClaudePlugin = !!(marketplaceName && p.source !== undefined && !p.package && !p.npm && !p.command && !p.url && !p.installCmd && !p.install);
    let installCmd = p.installCmd || p.install || (p.package ? `claude mcp add ${slug} -- npx -y ${p.package}` : '');
    if (!installCmd && isClaudePlugin) {
      installCmd = `claude plugin marketplace add ${marketplaceRef} && claude plugin install ${p.name || slug}@${marketplaceName}`;
    }
    return {
      pluginType: isClaudePlugin ? 'claude-plugin' : 'mcp',
      id:          src.id + '-' + slug,
      name:        p.name || p.id || 'Unknown',
      description: p.description || '',
      package:     p.package || p.npm || '',
      category:    p.category || 'Other',
      author:      p.author || src.name,
      official:    false,
      installCmd,
      // MCP server config for direct settings.json install
      mcpServerId: slug.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      mcpType:     p.type || (p.url ? 'sse' : 'stdio'),
      mcpCommand:  p.command || '',
      mcpArgs:     Array.isArray(p.args) ? p.args : [],
      mcpEnv:      p.env && typeof p.env === 'object' ? p.env : {},
      mcpUrl:      p.url || '',
      source: src.id, sourceIcon: src.icon || '🌐', sourceName: src.name,
    };
  });
}

app.get('/api/marketplace/sources', (req, res) => res.json(getMarketplaceSources()));

app.post('/api/marketplace/sources', (req, res) => {
  const { name, url, icon } = req.body;
  if (!name?.trim() || !url?.trim()) return res.status(400).json({ error: 'name and url are required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  const cfg = loadConfig();
  if (!cfg.marketplaceSources) cfg.marketplaceSources = [];
  const id = 'custom-' + Date.now();
  cfg.marketplaceSources.push({ id, name: name.trim(), url: url.trim(), icon: icon?.trim() || '🌐', type: 'custom', enabled: true });
  saveConfig(cfg);
  res.json({ ok: true, id });
});

app.delete('/api/marketplace/sources/:id', (req, res) => {
  const cfg = loadConfig();
  cfg.marketplaceSources = (cfg.marketplaceSources || []).filter(s => s.id !== req.params.id);
  saveConfig(cfg);
  res.json({ ok: true });
});

app.put('/api/marketplace/sources/:id/toggle', (req, res) => {
  const { id } = req.params;
  const cfg = loadConfig();
  if (id === 'npm-mcp') {
    cfg.npmSourceEnabled = cfg.npmSourceEnabled === false ? true : false;
    saveConfig(cfg);
    return res.json({ ok: true, enabled: cfg.npmSourceEnabled !== false });
  }
  const src = (cfg.marketplaceSources || []).find(s => s.id === id);
  if (!src) return res.status(404).json({ error: 'Source not found' });
  src.enabled = !src.enabled;
  saveConfig(cfg);
  res.json({ ok: true, enabled: src.enabled });
});

// Set of lowercase keys identifying everything currently installed:
// MCP server ids from settings.json + ~/.claude.json, and plugin base names
// from installed_plugins.json / enabledPlugins.
function getInstalledKeySet() {
  const keys = new Set();
  const settings = readJson(join(claudeDir, 'settings.json'));
  const pluginData = readJson(join(claudeDir, 'plugins', 'installed_plugins.json'), {});
  collectAllMcpServers().forEach(({ id }) => keys.add(id.toLowerCase()));
  [...Object.keys(settings.enabledPlugins || {}),
   ...Object.keys(pluginData.plugins || {}),
   ...Object.keys(pluginData.enabledPlugins || {})]
    .forEach(k => { keys.add(k.toLowerCase()); keys.add(k.split('@')[0].toLowerCase()); });
  return keys;
}

// Check every plausible identifier — the marketplace entry id is source-prefixed
// (e.g. "npm-...", "custom-...") and never matches the installed server key directly.
function isPluginInstalled(p, installedKeys) {
  return [p.id, p.mcpServerId, p.name, (p.package || '').split('/').pop(),
          (p.installCmd || '').match(/claude mcp add (\S+)/)?.[1],
          (p.installCmd || '').match(/claude plugin install (\S+)/)?.[1]]
    .filter(Boolean)
    .some(k => installedKeys.has(String(k).toLowerCase()));
}

app.get('/api/marketplace/browse', async (req, res) => {
  const { source = 'all', q = '' } = req.query;
  const sources = getMarketplaceSources();
  const installedKeys = getInstalledKeySet();

  let plugins = [];
  if (source === 'all' || source === 'official') {
    plugins.push(...MARKETPLACE.map(p => ({ ...p, source: 'official', sourceIcon: '🏛️', sourceName: 'Official' })));
  }
  const npmSrc = sources.find(s => s.id === 'npm-mcp');
  if (npmSrc?.enabled && (source === 'all' || source === 'npm-mcp')) {
    plugins.push(...await cachedFetch('npm-mcp', fetchNpmSource));
  }
  for (const src of sources.filter(s => s.type === 'custom' && s.enabled)) {
    if (source === 'all' || source === src.id) {
      plugins.push(...await cachedFetch(src.id, () => fetchCustomSource(src)));
    }
  }
  const lq = q.toLowerCase();
  if (lq) plugins = plugins.filter(p => p.name.toLowerCase().includes(lq) || p.description.toLowerCase().includes(lq) || (p.package || '').toLowerCase().includes(lq));
  plugins = plugins.map(p => ({ ...p, installed: isPluginInstalled(p, installedKeys) }));
  const sourceSummary = sources.map(s => ({ ...s, count: plugins.filter(p => p.source === s.id).length }));
  res.json({ plugins, sources: sourceSummary });
});

// --- API: Plugin Marketplace ---

const MARKETPLACE = [
  // ── Official Anthropic MCP servers ──────────────────────────────────────
  { id: 'filesystem', category: 'Files',        author: 'Anthropic', official: true,
    name: 'Filesystem',        description: 'Read, write, and navigate files and directories with configurable access controls.',
    package: '@modelcontextprotocol/server-filesystem',
    installCmd: 'claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem ~' },
  { id: 'github',     category: 'DevTools',     author: 'Anthropic', official: true,
    name: 'GitHub',            description: 'Manage repos, issues, PRs, code search, and file operations via GitHub API.',
    package: '@modelcontextprotocol/server-github',
    installCmd: 'claude mcp add github -e GITHUB_TOKEN=your_personal_access_token -- npx -y @modelcontextprotocol/server-github' },
  { id: 'postgres',   category: 'Database',     author: 'Anthropic', official: true,
    name: 'PostgreSQL',        description: 'Query and inspect PostgreSQL databases with full schema introspection.',
    package: '@modelcontextprotocol/server-postgres',
    installCmd: 'claude mcp add postgres -- npx -y @modelcontextprotocol/server-postgres postgresql://localhost/mydb' },
  { id: 'brave-search', category: 'Search',     author: 'Anthropic', official: true,
    name: 'Brave Search',      description: 'Real-time web and local search using Brave Search API.',
    package: '@modelcontextprotocol/server-brave-search',
    installCmd: 'claude mcp add brave-search -e BRAVE_API_KEY=your_brave_api_key -- npx -y @modelcontextprotocol/server-brave-search' },
  { id: 'puppeteer',  category: 'Automation',   author: 'Anthropic', official: true,
    name: 'Puppeteer',         description: 'Headless browser automation: screenshots, form fills, and web scraping.',
    package: '@modelcontextprotocol/server-puppeteer',
    installCmd: 'claude mcp add puppeteer -- npx -y @modelcontextprotocol/server-puppeteer' },
  { id: 'memory',     category: 'Productivity', author: 'Anthropic', official: true,
    name: 'Memory',            description: 'Persistent knowledge graph storage that survives across Claude sessions.',
    package: '@modelcontextprotocol/server-memory',
    installCmd: 'claude mcp add memory -- npx -y @modelcontextprotocol/server-memory' },
  { id: 'fetch',      category: 'Web',          author: 'Anthropic', official: true,
    name: 'Fetch',             description: 'Fetch any URL and convert web pages to clean markdown for Claude to read.',
    package: '@modelcontextprotocol/server-fetch',
    installCmd: 'claude mcp add fetch -- npx -y @modelcontextprotocol/server-fetch' },
  { id: 'sqlite',     category: 'Database',     author: 'Anthropic', official: true,
    name: 'SQLite',            description: 'Read, query, and inspect SQLite databases with schema exploration.',
    package: '@modelcontextprotocol/server-sqlite',
    installCmd: 'claude mcp add sqlite -- npx -y @modelcontextprotocol/server-sqlite /path/to/database.db' },
  { id: 'slack',      category: 'Productivity', author: 'Anthropic', official: true,
    name: 'Slack',             description: 'Read channels, post messages, and manage Slack workspaces.',
    package: '@modelcontextprotocol/server-slack',
    installCmd: 'claude mcp add slack -e SLACK_BOT_TOKEN=xoxb-your-token -e SLACK_TEAM_ID=T0000000000 -- npx -y @modelcontextprotocol/server-slack' },
  { id: 'google-maps', category: 'Maps',        author: 'Anthropic', official: true,
    name: 'Google Maps',       description: 'Location search, directions, place details, and geocoding.',
    package: '@modelcontextprotocol/server-google-maps',
    installCmd: 'claude mcp add google-maps -e GOOGLE_MAPS_API_KEY=your_api_key -- npx -y @modelcontextprotocol/server-google-maps' },
  // ── Community servers ────────────────────────────────────────────────────
  { id: 'context7',   category: 'DevTools',     author: 'Upstash',   official: false,
    name: 'Context7',          description: 'Fetch up-to-date library docs and code examples from thousands of packages.',
    package: '@upstash/context7-mcp',
    installCmd: 'claude mcp add context7 -- npx -y @upstash/context7-mcp' },
  { id: 'linear',     category: 'DevTools',     author: 'Linear',    official: false,
    name: 'Linear',            description: 'Create and manage Linear issues, projects, cycles, and team workflows.',
    package: '@linear/linear-mcp',
    installCmd: 'claude mcp add linear -e LINEAR_API_KEY=your_linear_api_key -- npx -y @linear/linear-mcp' },
  { id: 'notion',     category: 'Productivity', author: 'Notion',    official: false,
    name: 'Notion',            description: 'Read and write Notion pages, databases, comments, and blocks.',
    package: '@notionhq/notion-mcp-server',
    installCmd: 'claude mcp add notion -e OPENAPI_MCP_HEADERS=\'{"Authorization":"Bearer your_token","Notion-Version":"2022-06-28"}\' -- npx -y @notionhq/notion-mcp-server' },
  { id: 'sentry',     category: 'DevTools',     author: 'Sentry',    official: false,
    name: 'Sentry',            description: 'Query Sentry errors, issues, stack traces, and project stats.',
    package: '@sentry/mcp-server-sentry',
    installCmd: 'claude mcp add sentry -e SENTRY_AUTH_TOKEN=your_auth_token -- npx -y @sentry/mcp-server-sentry --host sentry.io' },
  { id: 'figma',      category: 'Design',       author: 'Community', official: false,
    name: 'Figma',             description: 'Read Figma designs, inspect components, and export assets programmatically.',
    package: 'figma-developer-mcp',
    installCmd: 'claude mcp add figma -e FIGMA_API_KEY=your_figma_api_key -- npx -y figma-developer-mcp' },
  { id: 'todoist',    category: 'Productivity', author: 'Doist',     official: false,
    name: 'Todoist',           description: 'Manage tasks, projects, labels, and filters in Todoist.',
    package: '@doist/todoist-mcp-server',
    installCmd: 'claude mcp add todoist -e TODOIST_API_TOKEN=your_api_token -- npx -y @doist/todoist-mcp-server' },
  { id: 'mermaid',    category: 'DevTools',     author: 'Community', official: false,
    name: 'Mermaid Chart',     description: 'Render and validate Mermaid diagrams and export them as images.',
    package: '@mermaid-js/mermaid-mcp',
    installCmd: 'claude mcp add mermaid -- npx -y @mermaid-js/mermaid-mcp' },
];

app.get('/api/marketplace', (req, res) => {
  const installedKeys = getInstalledKeySet();
  res.json(MARKETPLACE.map(p => ({ ...p, source: 'official', sourceIcon: '🏛️', sourceName: 'Official', installed: isPluginInstalled(p, installedKeys) })));
});

// Allowed install commands. Supports `&&`-chained claude commands so Claude Code
// plugin marketplaces can be added and their plugin installed in one click.
const ALLOWED_INSTALL_CMDS = [
  /^claude mcp add /,
  /^claude plugin install /,
  /^claude plugin marketplace add /,
];
app.post('/api/marketplace/:id/install', (req, res) => {
  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: 'command is required' });
  const segments = command.split('&&').map(s => s.trim()).filter(Boolean);
  const invalid = segments.find(seg => !ALLOWED_INSTALL_CMDS.some(rx => rx.test(seg)));
  if (!segments.length || invalid !== undefined) {
    return res.status(400).json({ error: `Only "claude mcp add", "claude plugin marketplace add" and "claude plugin install" commands can be run from here (got "${(invalid || command).trim().split(' ')[0]}"). Copy the command and run it manually, or use "Write to settings.json".` });
  }
  // `claude mcp add` defaults to LOCAL scope (tied to this server's cwd, invisible
  // in other projects). Default to user scope unless the user set a scope explicitly.
  const finalCmd = segments.map(seg =>
    /^claude mcp add /.test(seg) && !/\s(?:-s|--scope)(?:\s|=)/.test(seg)
      ? seg.replace(/^claude mcp add /, 'claude mcp add --scope user ')
      : seg
  ).join(' && ');
  exec(finalCmd, { timeout: 90000, shell: true }, (err, stdout, stderr) => {
    if (err) {
      const msg = (stderr || err.message).trim();
      // "already exists in local/user/project config" — treat as informational:
      // the server is installed, it just was added before (possibly in another scope).
      if (/already exists/i.test(msg)) {
        return res.json({ ok: true, alreadyInstalled: true, output: msg + '\n(Already installed — no changes made.)', id: req.params.id });
      }
      return res.status(500).json({ error: msg, stdout });
    }
    res.json({ ok: true, output: (stdout || '').trim() || 'Installed.', executed: finalCmd, id: req.params.id });
  });
});

// Direct write to settings.json for plugins that don't use claude mcp add
app.post('/api/marketplace/direct-install', (req, res) => {
  const { serverId, type, command, args, env, url } = req.body;
  if (!serverId) return res.status(400).json({ error: 'serverId is required' });
  if (!command && !url) return res.status(400).json({ error: 'command or url is required' });
  try {
    const settingsPath = join(claudeDir, 'settings.json');
    const settings = readJson(settingsPath) || {};
    if (!settings.mcpServers) settings.mcpServers = {};
    const cfg = type === 'sse' || type === 'http'
      ? { type: type || 'sse', url }
      : { type: 'stdio', command, args: args || [], ...(env && Object.keys(env).length ? { env } : {}) };
    settings.mcpServers[serverId] = cfg;
    const tmp = settingsPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(settings, null, 2));
    renameSync(tmp, settingsPath);
    res.json({ ok: true, output: `Added "${serverId}" to mcpServers in settings.json. Restart Claude Code to activate.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- API: Skill Store ---

function fetchTextUrl(url) {
  return new Promise(resolve => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'claude-manager/1.0' } }, res => {
      if (res.statusCode === 404) { resolve(null); return; }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d || null));
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function parseSkillFrontmatter(content) {
  const fm = {};
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return fm;
  let inDescription = false;
  m[1].split('\n').forEach(line => {
    if (inDescription) {
      if (/^\S/.test(line)) { inDescription = false; }
      else { fm.description = (fm.description || '') + ' ' + line.trim(); return; }
    }
    const colon = line.indexOf(':');
    if (colon < 0) return;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim();
    if (k === 'description' && v === '>') { inDescription = true; fm.description = ''; return; }
    fm[k] = v.replace(/^['"]|['"]$/g, '');
  });
  if (fm.description) fm.description = fm.description.trim();
  return fm;
}

// --- Skill Store sources ---

const OFFICIAL_SKILL_SOURCE = { id: 'official', name: 'Official Anthropic', icon: '🏛️', repo: 'anthropics/skills', path: 'skills', branch: 'main', enabled: true, builtin: true };

function getSkillSources() {
  const cfg = loadConfig();
  return [OFFICIAL_SKILL_SOURCE, ...(cfg.skillSources || [])];
}

// Generic GitHub skill source fetcher — works for any public repo
async function fetchGitHubSkillSource(src) {
  const [owner, repo] = src.repo.split('/');
  const skillsPath = src.path || 'skills';
  const branch     = src.branch || 'main';
  const dir = await fetchJsonUrl(`https://api.github.com/repos/${owner}/${repo}/contents/${skillsPath}`);
  if (!Array.isArray(dir)) throw new Error(`GitHub API unavailable for ${src.repo}. Check repo path and try again.`);
  const results = await Promise.all(dir.filter(e => e.type === 'dir').map(async entry => {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${skillsPath}/${entry.name}/SKILL.md`;
    const content = await fetchTextUrl(rawUrl);
    if (!content) return null;
    const fm = parseSkillFrontmatter(content);
    return {
      id:          src.id + '-' + entry.name,
      name:        entry.name,
      displayName: fm.name || entry.name,
      description: (fm.description || '').replace(/\s+/g, ' ').trim(),
      sourceId:    src.id,
      sourceLabel: (src.icon || '📦') + ' ' + src.name,
      githubUrl:   `https://github.com/${owner}/${repo}/tree/${branch}/${skillsPath}/${entry.name}`,
    };
  }));
  return results.filter(Boolean);
}

app.get('/api/skill-store/sources', (req, res) => res.json(getSkillSources()));

app.post('/api/skill-store/sources', (req, res) => {
  const { name, repo, path: skillsPath, branch, icon } = req.body;
  if (!name?.trim() || !repo?.trim()) return res.status(400).json({ error: 'name and repo are required' });
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) return res.status(400).json({ error: 'repo must be owner/repo format' });
  const cfg = loadConfig();
  cfg.skillSources = cfg.skillSources || [];
  const id = 'custom-' + Date.now();
  cfg.skillSources.push({ id, name: name.trim(), repo: repo.trim(), path: skillsPath?.trim() || 'skills', branch: branch?.trim() || 'main', icon: icon?.trim() || '📦', enabled: true });
  saveConfig(cfg);
  res.json({ ok: true, id });
});

app.delete('/api/skill-store/sources/:id', (req, res) => {
  const cfg = loadConfig();
  cfg.skillSources = (cfg.skillSources || []).filter(s => s.id !== req.params.id);
  saveConfig(cfg);
  delete _mktCache['skill-store-' + req.params.id];
  res.json({ ok: true });
});

app.put('/api/skill-store/sources/:id/toggle', (req, res) => {
  const cfg = loadConfig();
  const src = (cfg.skillSources || []).find(s => s.id === req.params.id);
  if (!src) return res.status(404).json({ error: 'Source not found' });
  src.enabled = !src.enabled;
  saveConfig(cfg);
  res.json({ ok: true, enabled: src.enabled });
});

app.get('/api/skill-store/browse', async (req, res) => {
  try {
    const skillsDir = join(claudeDir, 'skills');
    const installed = new Set();
    if (existsSync(skillsDir)) {
      readdirSync(skillsDir, { withFileTypes: true }).forEach(e => {
        installed.add(e.isDirectory() ? e.name.toLowerCase() : e.name.replace(/\.md$/i, '').toLowerCase());
      });
    }
    const sources = getSkillSources().filter(s => s.enabled !== false);
    const allSkills = (await Promise.all(
      sources.map(src => cachedFetch('skill-store-' + src.id, () => fetchGitHubSkillSource(src)).catch(e => { console.warn('Skill store source error:', src.id, e.message); return []; }))
    )).flat();
    res.json(allSkills.map(s => ({ ...s, installed: installed.has(s.name.toLowerCase()) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recursively download all files for a skill from the GitHub tree
app.post('/api/skill-store/install', async (req, res) => {
  const { skillName, sourceId = 'official' } = req.body;
  if (!skillName || !/^[a-zA-Z0-9_-]+$/.test(skillName)) return res.status(400).json({ error: 'Invalid skill name' });
  try {
    const src = getSkillSources().find(s => s.id === sourceId) || OFFICIAL_SKILL_SOURCE;
    const [owner, repo] = src.repo.split('/');
    const branch     = src.branch || 'main';
    const skillsPath = src.path || 'skills';

    const treeKey = `github-tree-${src.id}`;
    const tree = await cachedFetch(treeKey, () =>
      fetchJsonUrl(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`)
    );
    if (!tree?.tree) return res.status(500).json({ error: 'Could not fetch repo tree from GitHub' });

    const prefix = `${skillsPath}/${skillName}/`;
    const files = tree.tree.filter(f => f.type === 'blob' && f.path.startsWith(prefix));
    if (!files.length) return res.status(404).json({ error: `Skill "${skillName}" not found in ${src.repo}` });

    const skillsDir = join(claudeDir, 'skills');
    ensureDir(skillsDir);
    const localSkillDir = join(skillsDir, skillName);
    ensureDir(localSkillDir);

    const results = await Promise.all(files.map(async file => {
      const relativePath = file.path.slice(prefix.length);
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
      const content = await fetchTextUrl(rawUrl);
      if (content === null) return { path: relativePath, ok: false };
      const segments = relativePath.split('/').filter(Boolean);
      const localPath = join(localSkillDir, ...segments);
      if (!localPath.startsWith(localSkillDir + path.sep) && localPath !== localSkillDir)
        return { path: relativePath, ok: false, error: 'path traversal' };
      ensureDir(join(localPath, '..'));
      atomicWrite(localPath, content);
      return { path: relativePath, ok: true };
    }));

    res.json({ ok: true, installed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, files: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API: Agents ---

app.get('/api/agents', (req, res) => {
  const agentsDir = join(claudeDir, 'agents');
  const agents = [];

  // agents/ — RECURSIVE: agents in subfolders (e.g. agents/team/reviewer.md)
  // were previously invisible. Per-file try/catch so one bad file can't
  // blank the whole tab.
  if (existsSync(agentsDir)) {
    for (const full of walkFiles(agentsDir)) {
      if (!full.endsWith('.md')) continue;
      try {
        const content = readFileSync(full, 'utf8');
        const meta = parseFrontmatter(content);
        const stat = statSync(full);
        const rel = relPath(agentsDir, full);
        agents.push({
          name: rel.replace(/\.md$/, ''),
          path: 'agents/' + rel,
          description: (meta.description || '').slice(0, 120),
          model: meta.model || '',
          tools: normalizeTools(meta.tools),
          lint: lintToolConsistency('agent', content),
          size: formatSize(stat.size),
          modified: stat.mtime.toISOString(),
        });
      } catch {}
    }
  }

  // Agents shipped inside INSTALLED plugins or skills (any nested agents/ folder).
  // NB: plugins/marketplaces holds browsable CATALOG checkouts, not installed
  // plugins — never list agents from there (they aren't installed).
  for (const dirName of ['plugins', 'skills']) {
    const base = join(claudeDir, dirName);
    if (!existsSync(base)) continue;
    for (const full of walkFiles(base)) {
      if (!full.endsWith('.md')) continue;
      const rel = relPath(claudeDir, full);
      if (rel.startsWith('plugins/marketplaces/') || rel.startsWith('plugins/cache/')) continue;
      if (!/(^|\/)agents\//.test(rel)) continue;
      try {
        const content = readFileSync(full, 'utf8');
        const meta = parseFrontmatter(content);
        const stat = statSync(full);
        agents.push({
          name: basename(full, '.md'),
          path: rel,
          external: true,
          locationLabel: rel.split('/').slice(0, 2).join('/'),
          description: (meta.description || '').slice(0, 120),
          model: meta.model || '',
          tools: normalizeTools(meta.tools),
          size: formatSize(stat.size),
          modified: stat.mtime.toISOString(),
        });
      } catch {}
    }
  }

  res.json(agents);
});

app.get('/api/agents/:name', (req, res) => {
  try {
    const filePath = safePath(join(claudeDir, 'agents'), req.params.name + '.md');
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Agent not found' });
    res.json({ name: req.params.name, content: readFileSync(filePath, 'utf8') });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/agents', (req, res) => {
  const { name, content } = req.body;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: 'Invalid agent name' });
  const agentsDir = join(claudeDir, 'agents');
  ensureDir(agentsDir);
  try {
    const filePath = safePath(agentsDir, name + '.md');
    if (existsSync(filePath)) return res.status(409).json({ error: 'Agent already exists' });
    atomicWrite(filePath, content ?? `---\nname: ${name}\ndescription: >\n  Describe this agent.\n---\n\nAgent instructions here.\n`);
    res.status(201).json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/agents/:name', (req, res) => {
  try {
    const agentsDir = join(claudeDir, 'agents');
    ensureDir(agentsDir);
    const filePath = safePath(agentsDir, req.params.name + '.md');
    ensureDir(dirname(filePath)); // nested agents (agents/team/reviewer.md)
    atomicWrite(filePath, req.body.content ?? '');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/agents/:name', (req, res) => {
  try {
    const filePath = safePath(join(claudeDir, 'agents'), req.params.name + '.md');
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Agent not found' });
    unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Agent Store ---

const OFFICIAL_AGENT_SOURCES = [
  { id: 'agents-hooks-mastery',  name: 'Hooks Mastery Agents (disler)',      icon: '🤖', repo: 'disler/claude-code-hooks-mastery',                    path: '.claude/agents', branch: 'main', ext: '.md', enabled: true, builtin: true },
  { id: 'agents-observability',  name: 'Observability Agents (disler)',       icon: '🔭', repo: 'disler/claude-code-hooks-multi-agent-observability',   path: '.claude/agents', branch: 'main', ext: '.md', enabled: true, builtin: true },
  { id: 'agents-addyosmani',     name: 'Agent Skills (addyosmani)',           icon: '⚡', repo: 'addyosmani/agent-skills',                              path: 'agents',         branch: 'main', ext: '.md', enabled: true, builtin: true },
];

function getAgentSources() {
  const cfg = loadConfig();
  return [...OFFICIAL_AGENT_SOURCES, ...(cfg.agentSources || [])];
}

// --- Hook Store ---

const OFFICIAL_HOOK_SOURCES = [
  { id: 'hooks-mastery',       name: 'Hooks Mastery (disler)',          icon: '🔌', repo: 'disler/claude-code-hooks-mastery',                  path: '.claude/hooks', branch: 'main', ext: '.py',  enabled: true, builtin: true },
  { id: 'hooks-observability', name: 'Multi-Agent Observability (disler)', icon: '🔭', repo: 'disler/claude-code-hooks-multi-agent-observability', path: '.claude/hooks', branch: 'main', ext: '.py',  enabled: true, builtin: true },
];

function getHookSources() {
  const cfg = loadConfig();
  return [...OFFICIAL_HOOK_SOURCES, ...(cfg.hookSources || [])];
}

// Generic flat-file GitHub source fetcher (agents = .md, hooks = .mjs)
async function fetchGitHubFileSource(src) {
  const [owner, repo] = src.repo.split('/');
  const branch  = src.branch || 'main';
  const ext     = src.ext || '.md';
  const treeKey = 'github-tree-' + src.id;
  const tree = await cachedFetch(treeKey, () =>
    fetchJsonUrl(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`)
  );
  if (!tree?.tree) throw new Error(`Could not fetch tree for ${src.repo}`);

  const prefix = src.path ? src.path + '/' : '';
  const files  = tree.tree.filter(f =>
    f.type === 'blob' &&
    f.path.startsWith(prefix) &&
    f.path.endsWith(ext) &&
    f.path.slice(prefix.length).indexOf('/') === -1
  );

  const results = await Promise.all(files.map(async f => {
    try {
      const rawUrl  = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${f.path}`;
      const content = await fetchTextUrl(rawUrl);
      if (!content) return null;
      const fm   = parseSkillFrontmatter(content);
      const name = path.basename(f.path, ext);
      return {
        id:          src.id + '-' + name,
        name,
        displayName: fm.name || name,
        description: (fm.description || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        sourceId:    src.id,
        sourceLabel: (src.icon || '📦') + ' ' + src.name,
        githubUrl:   `https://github.com/${owner}/${repo}/blob/${branch}/${f.path}`,
        ext,
      };
    } catch (e) { return null; }
  }));
  return results.filter(Boolean);
}

// Agent Store endpoints
app.get('/api/agent-store/sources', (req, res) => res.json(getAgentSources()));

app.post('/api/agent-store/sources', (req, res) => {
  const { name, repo, path: p, branch, icon, ext } = req.body;
  if (!name?.trim() || !repo?.trim()) return res.status(400).json({ error: 'name and repo are required' });
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) return res.status(400).json({ error: 'repo must be owner/repo format' });
  const cfg = loadConfig();
  cfg.agentSources = cfg.agentSources || [];
  const id = 'custom-agent-' + Date.now();
  cfg.agentSources.push({ id, name: name.trim(), repo: repo.trim(), path: p?.trim() || '', branch: branch?.trim() || 'main', icon: icon?.trim() || '🤖', ext: ext?.trim() || '.md', enabled: true });
  saveConfig(cfg);
  res.json({ ok: true, id });
});

app.delete('/api/agent-store/sources/:id', (req, res) => {
  const cfg = loadConfig();
  cfg.agentSources = (cfg.agentSources || []).filter(s => s.id !== req.params.id);
  saveConfig(cfg);
  delete _mktCache['github-tree-' + req.params.id];
  res.json({ ok: true });
});

app.put('/api/agent-store/sources/:id/toggle', (req, res) => {
  const cfg = loadConfig();
  const src = (cfg.agentSources || []).find(s => s.id === req.params.id);
  if (!src) return res.status(404).json({ error: 'Source not found' });
  src.enabled = !src.enabled;
  saveConfig(cfg);
  res.json({ ok: true, enabled: src.enabled });
});

app.get('/api/agent-store/browse', async (req, res) => {
  try {
    const agentsDir = join(claudeDir, 'agents');
    const installed = new Set();
    if (existsSync(agentsDir)) {
      readdirSync(agentsDir).filter(f => f.endsWith('.md')).forEach(f => installed.add(f.replace(/\.md$/i, '').toLowerCase()));
    }
    const sources = getAgentSources().filter(s => s.enabled !== false);
    const allAgents = (await Promise.all(
      sources.map(src => cachedFetch('agent-store-' + src.id, () => fetchGitHubFileSource(src)).catch(e => { console.warn('Agent store source error:', src.id, e.message); return []; }))
    )).flat();
    res.json(allAgents.map(a => ({ ...a, installed: installed.has(a.name.toLowerCase()) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent-store/install', async (req, res) => {
  const { agentName, sourceId } = req.body;
  if (!agentName || !/^[a-zA-Z0-9_-]+$/.test(agentName)) return res.status(400).json({ error: 'Invalid agent name' });
  try {
    const allSources = getAgentSources();
    const src = sourceId ? allSources.find(s => s.id === sourceId) : allSources[0];
    if (!src) return res.status(400).json({ error: `Source "${sourceId}" not found. Refresh the store and try again.` });

    const [owner, repo] = src.repo.split('/');
    const branch   = src.branch || 'main';
    const ext      = src.ext || '.md';
    const prefix   = src.path ? src.path + '/' : '';
    const filePath = prefix + agentName + ext;

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
    const content = await fetchTextUrl(rawUrl);
    if (!content) return res.status(404).json({ error: `Agent "${agentName}" not found in ${src.repo} (${src.branch || 'main'} branch, path: ${src.path || '/'})` });
    if (content.trim().length < 10) return res.status(422).json({ error: `Agent file appears empty in ${src.repo}` });

    const agentsDir = join(claudeDir, 'agents');
    ensureDir(agentsDir);
    const localPath = safePath(agentsDir, agentName + '.md');
    atomicWrite(localPath, content);
    res.json({ ok: true, path: localPath, size: content.length, source: src.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hook Store endpoints
app.get('/api/hook-store/sources', (req, res) => res.json(getHookSources()));

app.post('/api/hook-store/sources', (req, res) => {
  const { name, repo, path: p, branch, icon, ext } = req.body;
  if (!name?.trim() || !repo?.trim()) return res.status(400).json({ error: 'name and repo are required' });
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) return res.status(400).json({ error: 'repo must be owner/repo format' });
  const cfg = loadConfig();
  cfg.hookSources = cfg.hookSources || [];
  const id = 'custom-hook-' + Date.now();
  cfg.hookSources.push({ id, name: name.trim(), repo: repo.trim(), path: p?.trim() || 'hooks', branch: branch?.trim() || 'main', icon: icon?.trim() || '🪝', ext: ext?.trim() || '.mjs', enabled: true });
  saveConfig(cfg);
  res.json({ ok: true, id });
});

app.delete('/api/hook-store/sources/:id', (req, res) => {
  const cfg = loadConfig();
  cfg.hookSources = (cfg.hookSources || []).filter(s => s.id !== req.params.id);
  saveConfig(cfg);
  delete _mktCache['github-tree-' + req.params.id];
  res.json({ ok: true });
});

app.put('/api/hook-store/sources/:id/toggle', (req, res) => {
  const cfg = loadConfig();
  const src = (cfg.hookSources || []).find(s => s.id === req.params.id);
  if (!src) return res.status(404).json({ error: 'Source not found' });
  src.enabled = !src.enabled;
  saveConfig(cfg);
  res.json({ ok: true, enabled: src.enabled });
});

app.get('/api/hook-store/browse', async (req, res) => {
  try {
    const hooksDir = join(claudeDir, 'hooks');
    const installed = new Set();
    if (existsSync(hooksDir)) {
      readdirSync(hooksDir).forEach(f => { if (!f.startsWith('.')) installed.add(f.replace(/\.[^.]+$/, '').toLowerCase()); });
    }
    const sources = getHookSources().filter(s => s.enabled !== false);
    const allHooks = (await Promise.all(
      sources.map(src => cachedFetch('hook-store-' + src.id, () => fetchGitHubFileSource(src)).catch(e => { console.warn('Hook store source error:', src.id, e.message); return []; }))
    )).flat();
    res.json(allHooks.map(h => ({ ...h, installed: installed.has(h.name.toLowerCase()) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/hook-store/install', async (req, res) => {
  const { hookName, sourceId } = req.body;
  if (!hookName || !/^[a-zA-Z0-9_-]+$/.test(hookName)) return res.status(400).json({ error: 'Invalid hook name' });
  try {
    const allSources = getHookSources();
    const src = sourceId ? allSources.find(s => s.id === sourceId) : allSources[0];
    if (!src) return res.status(400).json({ error: `Source "${sourceId}" not found. Refresh the store and try again.` });

    const [owner, repo] = src.repo.split('/');
    const branch = src.branch || 'main';
    const ext    = src.ext || '.mjs';
    const prefix = src.path ? src.path + '/' : '';
    const filePath = prefix + hookName + ext;

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
    const content = await fetchTextUrl(rawUrl);
    if (!content) return res.status(404).json({ error: `Hook "${hookName}" not found in ${src.repo} (${src.branch || 'main'} branch, path: ${src.path || '/'})` });
    if (content.trim().length < 5) return res.status(422).json({ error: `Hook file appears empty in ${src.repo}` });

    const hooksDir = join(claudeDir, 'hooks');
    ensureDir(hooksDir);
    const filename  = hookName + ext;
    const localPath = safePath(hooksDir, filename);
    atomicWrite(localPath, content);
    try { execSync(`chmod +x "${localPath.replace(/"/g, '\\"')}"`, { shell: true }); } catch {}
    res.json({ ok: true, path: localPath, filename, ext, size: content.length, source: src.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API: One-shot Runner ---
// Runs a skill / agent / workflow non-interactively (`claude -p`) with all
// permissions granted, streaming the JSON output into a user-chosen .jsonl file.

const _runs = {};
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

function buildRunPrompt(kind, name, task, expectedOutput) {
  const t = (task || '').trim();
  // The output contract lives in its own block, never inlined into the
  // slash-command argument string.
  const spec = (expectedOutput || '').trim();
  const outSpec = spec
    ? `\n\nEXPECTED OUTPUT — the run is complete only when this is delivered exactly:\n${spec}`
    : '';
  if (kind === 'skill' || kind === 'command') return (`/${name} ${t}`).trim() + outSpec;
  if (kind === 'agent') {
    return `Read the agent definition at ${join(claudeDir, 'agents', name + '.md')} and act as that agent. `
         + `Follow its steps, tool constraints, and output contract exactly.`
         + (t ? `\n\nTask: ${t}` : '\n\nTask: perform the agent\'s default responsibility on the current directory.')
         + outSpec;
  }
  // workflow: free-form goal
  return (t || `Execute the "${name}" workflow on the current directory.`) + outSpec;
}

const RUN_KINDS = ['skill', 'agent', 'command', 'workflow'];

function runArtifactPath(kind, name) {
  if (kind === 'skill')   return join(claudeDir, 'skills', name, 'SKILL.md');
  if (kind === 'agent')   return join(claudeDir, 'agents', name + '.md');
  if (kind === 'command') return join(claudeDir, 'commands', name + '.md');
  return null;
}

function shellQuote(s) { return `'` + String(s).replace(/'/g, `'\\''`) + `'`; }

// What does this skill/agent/command accept, and how would you run it yourself?
app.get('/api/run/info', (req, res) => {
  const { kind = 'skill', name = '' } = req.query;
  if (!name || !/^[a-zA-Z0-9 _-]+$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
  if (!RUN_KINDS.includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  const fp = runArtifactPath(kind, name);
  let meta = {};
  const exists = !!(fp && existsSync(fp));
  if (exists) { try { meta = parseFrontmatter(readFileSync(fp, 'utf8')); } catch {} }
  const argumentHint = meta['argument-hint'] || meta.argument_hint || '';
  const examplePrompt = buildRunPrompt(kind, name, argumentHint || '<your task>');
  res.json({
    kind, name, exists,
    description: typeof meta.description === 'string' ? meta.description : '',
    argumentHint,
    whenToUse: typeof meta.when_to_use === 'string' ? meta.when_to_use : '',
    // Copy-paste command to run the exact same one-shot manually — in the
    // right SHELL. bash/zsh gets a heredoc; Windows PowerShell gets a
    // here-string (no heredocs, backtick continuations, Out-File for UTF-8).
    // ?shell=powershell|bash overrides; default follows this machine's OS.
    manualCommand: (req.query.shell === 'powershell' || (req.query.shell !== 'bash' && process.platform === 'win32'))
      ? [
          `cd 'C:\\path\\to\\your\\project'`,
          `@'`,
          examplePrompt,
          `'@ | claude -p \``,
          `  --dangerously-skip-permissions \``,
          `  --output-format stream-json --verbose |`,
          `  Out-File -Encoding utf8 'run-output.jsonl'`,
        ].join('\n')
      : [
          `cd /path/to/your/project && claude -p \\`,
          `  --dangerously-skip-permissions \\`,
          `  --output-format stream-json --verbose \\`,
          `  > run-output.jsonl << 'PROMPT'`,
          examplePrompt,
          'PROMPT',
        ].join('\n'),
  });
});

app.post('/api/run/start', (req, res) => {
  const { kind = 'skill', name, task = '', outputFile, cwd, provider = 'claude-cli', expectedOutput = '' } = req.body;
  if (!name || !/^[a-zA-Z0-9 _-]+$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
  if (!RUN_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be one of: ' + RUN_KINDS.join(', ') });
  if (!outputFile?.trim()) return res.status(400).json({ error: 'outputFile is required — where should the JSONL stream be written?' });

  let workDir = cwd?.trim() ? resolve(expandHome(cwd.trim())) : homedir();
  if (!existsSync(workDir)) return res.status(400).json({ error: 'Working directory not found: ' + workDir });
  // Relative output paths land in the run's working directory (like the manual
  // command does after its cd) — not in wherever the server was started.
  const expandedOut = expandHome(outputFile.trim());
  let file = path.isAbsolute(expandedOut) ? resolve(expandedOut) : resolve(workDir, expandedOut);
  if (!/\.jsonl$/i.test(file)) file += '.jsonl';
  try { ensureDir(dirname(file)); } catch (e) { return res.status(400).json({ error: 'Cannot create output directory: ' + e.message }); }

  const id = 'run-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ── OpenRouter provider: text-only run (no local tool execution) ──
  // Sends the artifact definition + task to the model and writes the response
  // as JSONL events. Only available from the UI; useful when Claude CLI
  // isn't installed or for a quick dry-run of the artifact's logic.
  if (provider === 'openrouter') {
    const orCfg = loadConfig();
    if (!orCfg.openRouterKey) return res.status(400).json({ error: 'OpenRouter API key not configured. Add it in Settings > AI Generation.' });
    const fp = runArtifactPath(kind, name);
    const artifact = fp && existsSync(fp) ? readFileSync(fp, 'utf8') : '';
    const model = req.body.model?.trim() || orCfg.openRouterModel || 'anthropic/claude-sonnet-4-5';
    const run = {
      id, kind, name, file, provider: 'openrouter', cwd: workDir,
      prompt: ((task || '').trim() || 'Perform your default responsibility.')
        + ((expectedOutput || '').trim() ? `\n\nEXPECTED OUTPUT — the run is complete only when this is delivered exactly:\n${expectedOutput.trim()}` : ''),
      startedAt: new Date().toISOString(),
      running: true, exitCode: null, error: null, lines: 0, bytes: 0, tail: [], stderr: '',
    };
    _runs[id] = run;
    let ws2;
    try { ws2 = createWriteStream(file, { flags: 'a' }); } catch (e) { return res.status(400).json({ error: 'Cannot write output file: ' + e.message }); }
    const emit = obj => {
      const line = JSON.stringify(obj);
      ws2.write(line + '\n');
      run.lines++; run.bytes += line.length + 1;
      run.tail.push(line.length > 400 ? line.slice(0, 400) + '…' : line);
      if (run.tail.length > 25) run.tail.shift();
    };
    emit({ type: 'system', subtype: 'init', provider: 'openrouter', model, kind, name, note: 'Text-only run — OpenRouter cannot execute local tools.' });
    const sys = `You are performing a one-shot ${kind} run in TEXT-ONLY mode (no tool execution is available). `
      + `Follow the ${kind} definition below as faithfully as possible and produce the complete final output it would generate. `
      + `Where the definition requires running tools or reading files, state your assumptions and produce your best output anyway.\n\n`
      + `${kind.toUpperCase()} DEFINITION (${name}):\n${artifact || '(definition file not found — do your best from the name alone)'}`;
    callOpenRouter(orCfg.openRouterKey, model, sys, run.prompt)
      .then(text => {
        emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
        emit({ type: 'result', subtype: 'success', result: text.slice(0, 2000) });
        run.exitCode = 0; run.finishedAt = new Date().toISOString();
        try { ws2.end(() => { run.running = false; }); } catch { run.running = false; }
      })
      .catch(e => {
        emit({ type: 'result', subtype: 'error', error: e.message });
        run.exitCode = 1; run.error = e.message; run.finishedAt = new Date().toISOString();
        try { ws2.end(() => { run.running = false; }); } catch { run.running = false; }
      });
    return res.json({ ok: true, id, file, provider: 'openrouter', prompt: run.prompt, note: 'Text-only run — no local tools are executed.' });
  }

  // ── Claude CLI provider: full run with all permissions ──
  if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found. Install Claude Code, or switch the provider to OpenRouter for a text-only run.' });

  // Optional model pin (e.g. "sonnet", "opus", "haiku", or a full model string)
  const cliModel = (req.body.model || '').trim();
  if (cliModel && !/^[a-zA-Z0-9.:_-]+$/.test(cliModel)) return res.status(400).json({ error: 'Invalid model name' });

  const prompt = buildRunPrompt(kind, name, task, expectedOutput);
  const cmd = 'claude -p --dangerously-skip-permissions --output-format stream-json --verbose'
    + (cliModel ? ` --model ${cliModel}` : '');

  let ws;
  try { ws = createWriteStream(file, { flags: 'a' }); } catch (e) { return res.status(400).json({ error: 'Cannot write output file: ' + e.message }); }

  const child = spawn(cmd, { shell: true, cwd: workDir });
  const run = {
    id, kind, name, file, prompt, cwd: workDir,
    ...(cliModel ? { model: cliModel } : {}),
    startedAt: new Date().toISOString(),
    running: true, exitCode: null, error: null,
    lines: 0, bytes: 0, tail: [], stderr: '',
  };
  _runs[id] = run;

  let partial = '';
  child.stdout.on('data', chunk => {
    ws.write(chunk);
    run.bytes += chunk.length;
    partial += chunk.toString();
    const parts = partial.split('\n');
    partial = parts.pop();
    for (const line of parts) {
      if (!line.trim()) continue;
      run.lines++;
      run.tail.push(line.length > 400 ? line.slice(0, 400) + '…' : line);
      if (run.tail.length > 25) run.tail.shift();
    }
  });
  child.stderr.on('data', d => { run.stderr = (run.stderr + d.toString()).slice(-2000); });
  const killTimer = setTimeout(() => { try { child.kill('SIGTERM'); run.error = 'Timed out after 15 minutes'; } catch {} }, RUN_TIMEOUT_MS);
  // NB: mark the run finished only AFTER the write stream has flushed to disk —
  // otherwise a poller can read a truncated JSONL file.
  child.on('error', e => {
    run.error = e.message;
    clearTimeout(killTimer);
    try { ws.end(() => { run.running = false; }); } catch { run.running = false; }
  });
  child.on('close', code => {
    if (partial.trim()) { run.lines++; run.tail.push(partial.slice(0, 400)); }
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    clearTimeout(killTimer);
    try { ws.end(() => { run.running = false; }); } catch { run.running = false; }
  });
  try { child.stdin.write(prompt); child.stdin.end(); } catch {}

  run._child = child;
  res.json({ ok: true, id, file, prompt, command: cmd + '  (prompt piped via stdin)' });
});

app.get('/api/run/:id', (req, res) => {
  const run = _runs[req.params.id];
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const { _child, ...pub } = run;
  res.json(pub);
});

app.post('/api/run/:id/stop', (req, res) => {
  const run = _runs[req.params.id];
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.running && run._child) { try { run._child.kill('SIGTERM'); } catch {} run.error = 'Stopped by user'; }
  res.json({ ok: true });
});

app.get('/api/runs', (req, res) => {
  res.json(Object.values(_runs).map(({ _child, tail, ...r }) => r).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50));
});

// --- API: Updates from Anthropic ---
// Keeps the app aligned with Anthropic's moving targets: the Claude Code CLI
// version (npm) and the hook-event catalog (docs). New events discovered in
// the docs can be applied and immediately appear in all event dropdowns.

const BUILTIN_HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
  'SessionStart', 'SessionEnd', 'Setup', 'UserPromptSubmit',
  'Stop', 'StopFailure', 'Notification',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'ConfigChange', 'CwdChanged', 'FileChanged',
];
// Hook events are CamelCase with a recognizable final hump (PreToolUse,
// PermissionDenied, FileChanged…) or one of a few single-word names.
const HOOK_EVENT_SUFFIXES = ['Use', 'Failure', 'Request', 'Denied', 'Submit', 'Start', 'Stop', 'End', 'Compact', 'Change', 'Changed'];
const HOOK_EVENT_SINGLES = new Set(['Stop', 'Setup', 'Notification']);
const HOOK_EVENT_BLOCKLIST = new Set(['QuickStart', 'GetStarted', 'JumpStart', 'ChangeLog']);

function extractHookEvents(text) {
  const counts = {};
  (text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)*\b/g) || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  const out = new Set();
  for (const [tok, n] of Object.entries(counts)) {
    if (n < 3 || HOOK_EVENT_BLOCKLIST.has(tok)) continue; // must recur — one-off prose words don't
    if (HOOK_EVENT_SINGLES.has(tok)) { out.add(tok); continue; }
    const humps = tok.match(/[A-Z][a-z]+/g) || [];
    if (humps.length < 2) continue;
    if (HOOK_EVENT_SUFFIXES.includes(humps[humps.length - 1])) out.add(tok);
  }
  return [...out];
}

app.get('/api/hook-events', (req, res) => {
  const cfg = loadConfig();
  const dynamic = (cfg.dynamicHookEvents || []).filter(e => !BUILTIN_HOOK_EVENTS.includes(e));
  res.json({ builtin: BUILTIN_HOOK_EVENTS, dynamic, all: [...BUILTIN_HOOK_EVENTS, ...dynamic] });
});

// Settings keys the suggest-settings catalog already teaches — doc discovery
// reports anything beyond these as new (same pattern as hook events).
const KNOWN_SETTINGS_KEYS = [
  'model', 'permissions', 'env', 'hooks', 'includeCoAuthoredBy', 'cleanupPeriodDays',
  'statusLine', 'outputStyle', 'alwaysThinkingEnabled', 'enabledPlugins', 'skillOverrides',
  'disableBundledSkills', 'disableSkillShellExecution', 'sandbox', 'skillListingBudgetFraction',
  'defaultMode', 'additionalDirectories', 'disableBypassPermissionsMode', 'allow', 'deny', 'ask',
];

// Keys appear in the docs as the backticked first column of settings tables.
function extractSettingsKeys(text) {
  const out = new Set();
  for (const m of text.matchAll(/\|\s*`([a-zA-Z][\w.]{1,40})`\s*\|/g)) {
    const key = m[1].split('.')[0];
    if (/^[a-z]/.test(key)) out.add(key); // real keys are camelCase; skips tool names
  }
  return [...out];
}

app.get('/api/updates/check', async (req, res) => {
  const result = {
    appVersion: readJson(join(__dirname, 'package.json'), {}).version || 'unknown',
    checkedAt: new Date().toISOString(),
  };

  // 1) Claude Code CLI: installed version vs latest on npm
  let cliCurrent = null;
  try {
    cliCurrent = execSync('claude --version', { shell: true, stdio: 'pipe', timeout: 8000 })
      .toString().match(/\d+\.\d+\.\d+/)?.[0] || null;
  } catch {}
  const npmUrl = process.env.UPDATES_NPM_URL || 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
  const latestPkg = await fetchJsonUrl(npmUrl);
  const cliLatest = latestPkg?.version || null;
  result.cli = {
    installed: !!cliCurrent,
    current: cliCurrent,
    latest: cliLatest,
    hasUpdate: !!(cliCurrent && cliLatest && cliCurrent !== cliLatest),
  };

  // 2) Hook events: discover the catalog from Anthropic's docs
  const docsUrl = process.env.UPDATES_DOCS_URL || 'https://docs.claude.com/en/docs/claude-code/hooks';
  const page = await fetchTextUrl(docsUrl);
  if (page) {
    const found = extractHookEvents(page);
    const cfg = loadConfig();
    const known = new Set([...BUILTIN_HOOK_EVENTS, ...(cfg.dynamicHookEvents || [])]);
    result.hookEvents = {
      knownCount: known.size,
      foundCount: found.length,
      newEvents: found.filter(e => !known.has(e)).sort(),
      source: docsUrl,
    };
  } else {
    result.hookEvents = { error: 'Could not fetch the hooks documentation page — check your connection.' };
  }

  // 3) Settings keys: discover the catalog from the settings docs
  const settingsUrl = process.env.UPDATES_SETTINGS_URL || 'https://code.claude.com/docs/en/settings.md';
  const settingsPage = await fetchTextUrl(settingsUrl);
  if (settingsPage) {
    const cfg0 = loadConfig();
    const knownKeys = new Set([...KNOWN_SETTINGS_KEYS, ...(cfg0.dynamicSettingsKeys || [])]);
    const foundKeys = extractSettingsKeys(settingsPage);
    result.settingsKeys = {
      knownCount: knownKeys.size,
      foundCount: foundKeys.length,
      newKeys: foundKeys.filter(k => !knownKeys.has(k)).sort(),
      source: settingsUrl,
    };
  } else {
    result.settingsKeys = { error: 'Could not fetch the settings documentation page.' };
  }

  const cfg = loadConfig();
  cfg.lastUpdateCheck = result.checkedAt;
  saveConfig(cfg);
  res.json(result);
});

app.post('/api/updates/settings-keys/apply', (req, res) => {
  const { keys } = req.body;
  if (!Array.isArray(keys) || !keys.length || keys.some(k => typeof k !== 'string' || !/^[a-z][A-Za-z.]{1,40}$/.test(k))) {
    return res.status(400).json({ error: 'keys must be an array of setting key names' });
  }
  const cfg = loadConfig();
  cfg.dynamicSettingsKeys = [...new Set([...(cfg.dynamicSettingsKeys || []), ...keys])]
    .filter(k => !KNOWN_SETTINGS_KEYS.includes(k));
  saveConfig(cfg);
  res.json({ ok: true, dynamic: cfg.dynamicSettingsKeys });
});

app.post('/api/updates/hook-events/apply', (req, res) => {
  const { events } = req.body;
  if (!Array.isArray(events) || !events.length || events.some(e => typeof e !== 'string' || !/^[A-Za-z]{3,40}$/.test(e))) {
    return res.status(400).json({ error: 'events must be an array of event names' });
  }
  const cfg = loadConfig();
  cfg.dynamicHookEvents = [...new Set([...(cfg.dynamicHookEvents || []), ...events])]
    .filter(e => !BUILTIN_HOOK_EVENTS.includes(e));
  saveConfig(cfg);
  res.json({ ok: true, dynamic: cfg.dynamicHookEvents });
});

app.post('/api/updates/cli', (req, res) => {
  if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found — install it first: npm install -g @anthropic-ai/claude-code' });
  exec('claude update', { timeout: 120000, shell: true }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: (stderr || err.message).trim() || 'Update failed' });
    res.json({ ok: true, output: (stdout || '').trim() || 'Claude Code updated.' });
  });
});

// --- API: Custom Events (derived events, hook-event-creator) ---
// Claude Code cannot fire brand-new runtime events — but a CUSTOM EVENT can be
// derived: attach a hook to the right built-in event, detect one precise
// condition in the script, and act only then. This gives the condition a name,
// a definition file, and a registry entry — the hook-event equivalent of
// skill-creator.

const CE_LANG_RULES = {
  '.mjs': 'Node.js ESM (.mjs): starts with #!/usr/bin/env node; reads stdin JSON via readline lines joined at close; JSON.parse with {} fallback. Cross-platform — recommended.',
  '.py':  'Python 3 (.py): starts with #!/usr/bin/env python3; reads sys.stdin.read(); json.loads with {} fallback; sys.exit(0) on every path.',
  '.sh':  'Bash (.sh): starts with #!/usr/bin/env bash; INPUT=$(cat); extract JSON fields via a python3 one-liner helper; exit 0 on every path. macOS/Linux only.',
  '.ps1': 'PowerShell (.ps1): starts with a comment header line; reads [Console]::In.ReadToEnd(); ConvertFrom-Json inside try/catch; exit 0 on every path. Requires pwsh.',
};

const CUSTOM_EVENT_PROMPT_TEMPLATE = `You are a Claude Code custom-event designer.

Claude Code fires only its built-in lifecycle events. A CUSTOM EVENT is a
derived event: a hook attached to the correct built-in event whose script
detects ONE precise condition and acts only then — giving that condition a
name of its own.

Given the user's description, output ONLY raw JSON — no prose, no fences. The very
first character of your response must be '{' and the very last must be '}'.
{
  "name": "CamelCaseEventName",
  "description": "One sentence: when this custom event fires.",
  "underlyingEvent": "one of: {{EVENTS}}",
  "matcher": "tool-name regex for PreToolUse/PostToolUse/PostToolUseFailure/Permission* (e.g. \\"Bash\\", \\"Write|Edit\\"); empty string otherwise",
  "filename": "kebab-case-name{{EXT}}",
  "how": "2-3 sentences: how detection works and what the action does.",
  "hookScript": "the complete script"
}

hookScript rules — violations invalidate the output:
- LANGUAGE: {{LANG_RULES}} The filename MUST end with {{EXT}}.
- The FIRST comment block documents: CUSTOM EVENT <name>, fires when, underlying event, action taken.
- Detects the condition precisely; when it does NOT match, exit 0 immediately (the custom event simply did not fire).
- FAIL-OPEN: all logic inside try/catch, exit 0 in catch — a crashing hook must never block Claude.
- Performs the user's requested action: block (stdout {"decision":"block","reason":"[<name>] ..."}), log to a file, notify, or redirect Claude.
- Prefix any user-visible reason/log line with the event name in brackets so it is recognizable.
- If the condition cannot be reliably detected from any built-in event's payload, pick the
  closest event, detect what IS detectable, and state the limitation honestly in "how".

Request: `;

const CUSTOM_EVENT_PROMPT = (lang = '.mjs') => getPrompt('custom-event')
  .replaceAll('{{EVENTS}}', BUILTIN_HOOK_EVENTS.join(', '))
  .replaceAll('{{LANG_RULES}}', CE_LANG_RULES[lang] || CE_LANG_RULES['.mjs'])
  .replaceAll('{{EXT}}', lang);

app.post('/api/ai/create-custom-event', async (req, res) => {
  const { description, action = '', provider, lang: rawLang } = req.body;
  if (!description?.trim()) return res.status(400).json({ error: 'description is required — when should this event fire?' });
  const lang = CE_LANG_RULES[rawLang] ? rawLang : '.mjs';
  const fullPrompt = CUSTOM_EVENT_PROMPT(lang)
    + `When it should fire: ${description.trim()}`
    + (action.trim() ? `\nWhat should happen when it fires: ${action.trim()}` : '\nWhat should happen when it fires: block the action with a clear reason.');
  try {
    let raw;
    if (provider === 'openrouter') {
      const cfg = loadConfig();
      if (!cfg.openRouterKey) return res.status(400).json({ error: 'OpenRouter API key not configured.' });
      raw = await callOpenRouter(cfg.openRouterKey, cfg.openRouterModel || 'anthropic/claude-sonnet-4-5', '', fullPrompt);
    } else {
      if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found. Use OpenRouter instead.' });
      raw = await callClaudeCli(fullPrompt);
    }
    const def = JSON.parse(raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim());
    if (!/^[A-Z][A-Za-z0-9]{2,39}$/.test(def.name || '')) return res.status(500).json({ error: 'AI returned an invalid event name — try again.' });
    if (!BUILTIN_HOOK_EVENTS.includes(def.underlyingEvent)) return res.status(500).json({ error: `AI chose an unknown underlying event ("${def.underlyingEvent}") — try rephrasing.` });
    if (!def.hookScript?.trim().startsWith('#')) return res.status(500).json({ error: 'AI returned an invalid hook script — try again.' });
    // Coerce the filename to the requested language
    if (!/^[a-z0-9][a-z0-9-]*\.(mjs|js|py|sh|ps1)$/.test(def.filename || '')) {
      def.filename = def.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() + lang;
    }
    if (!def.filename.endsWith(lang)) def.filename = def.filename.replace(/\.[^.]+$/, '') + lang;
    def.lang = lang;
    res.json(def);
  } catch (e) {
    if (e instanceof SyntaxError) return res.status(500).json({ error: 'AI returned invalid JSON. Try again.' });
    res.status(500).json({ error: e.message });
  }
});

const HOOK_RUNNERS = { '.mjs': 'node', '.js': 'node', '.py': 'python3', '.sh': 'bash', '.ps1': 'pwsh' };

// Append a hook command to settings.json for an event/matcher, reusing groups.
function wireHookCommand(event, matcher, filename) {
  const settingsPath = join(claudeDir, 'settings.json');
  const settings = readJson(settingsPath);
  settings.hooks = settings.hooks || {};
  const groups = settings.hooks[event] = settings.hooks[event] || [];
  const runner = HOOK_RUNNERS[(filename.match(/\.[^.]+$/) || ['.mjs'])[0]] || 'node';
  const command = `${runner} "${join(claudeDir, 'hooks', filename)}"`;
  let group = groups.find(g => (g.matcher || '') === (matcher || ''));
  if (!group) { group = { ...(matcher ? { matcher } : {}), hooks: [] }; groups.push(group); }
  group.hooks = group.hooks || [];
  if (!group.hooks.some(h => h.command === command)) group.hooks.push({ type: 'command', command });
  writeJson(settingsPath, settings);
  return command;
}

// Wire an existing hooks/<filename> to a lifecycle event
app.post('/api/hooks/wire', (req, res) => {
  const { event, matcher = '', filename } = req.body;
  const cfg = loadConfig();
  const validEvents = [...BUILTIN_HOOK_EVENTS, ...(cfg.dynamicHookEvents || [])];
  if (!validEvents.includes(event)) return res.status(400).json({ error: `Unknown hook event "${event}"` });
  if (!filename || !/^[a-zA-Z0-9_.-]+$/.test(filename)) return res.status(400).json({ error: 'Invalid filename' });
  if (!existsSync(join(claudeDir, 'hooks', filename))) return res.status(404).json({ error: `hooks/${filename} does not exist — create the file first` });
  try {
    const command = wireHookCommand(event, matcher, filename);
    res.json({ ok: true, event, matcher, command });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/custom-events', (req, res) => {
  const cfg = loadConfig();
  const settings = readJson(join(claudeDir, 'settings.json'));
  const events = (cfg.customEvents || []).map(ev => {
    const filePath = join(claudeDir, 'hooks', ev.filename);
    const wired = JSON.stringify(settings.hooks || {}).includes(ev.filename);
    return { ...ev, fileExists: existsSync(filePath), wired };
  });
  res.json(events);
});

app.post('/api/custom-events/install', (req, res) => {
  const { name, description = '', underlyingEvent, matcher = '', filename, hookScript, how = '' } = req.body;
  if (!/^[A-Z][A-Za-z0-9]{2,39}$/.test(name || '')) return res.status(400).json({ error: 'name must be CamelCase (e.g. GitPushDetected)' });
  if (!BUILTIN_HOOK_EVENTS.includes(underlyingEvent)) return res.status(400).json({ error: 'underlyingEvent must be a real Claude Code event' });
  if (!/^[a-z0-9][a-z0-9-]*\.(mjs|js|py|sh|ps1)$/.test(filename || '')) return res.status(400).json({ error: 'filename must be kebab-case with .mjs/.js/.py/.sh/.ps1 extension' });
  if (!hookScript?.trim()) return res.status(400).json({ error: 'hookScript is required' });
  const cfg = loadConfig();
  if ((cfg.customEvents || []).some(e => e.name === name)) return res.status(409).json({ error: `Custom event "${name}" already exists` });
  try {
    // 1) write the script
    const hooksDir = join(claudeDir, 'hooks');
    ensureDir(hooksDir);
    const filePath = safePath(hooksDir, filename);
    atomicWrite(filePath, hookScript);
    if (process.platform !== 'win32') { try { execSync(`chmod +x "${filePath.replace(/"/g, '\\"')}"`, { shell: true }); } catch {} }
    // 2) wire it to the underlying event in settings.json
    const wiredCommand = wireHookCommand(underlyingEvent, matcher, filename);
    // 3) record in the registry
    cfg.customEvents = cfg.customEvents || [];
    cfg.customEvents.push({ name, description, underlyingEvent, matcher, filename, how, createdAt: new Date().toISOString() });
    saveConfig(cfg);
    res.status(201).json({
      ok: true, name, file: filePath,
      wiredTo: underlyingEvent + (matcher ? ` (matcher: ${matcher})` : ''),
      command: wiredCommand,
      // exact settings.json entry, so the UI can show precisely what was written
      settingsSnippet: { hooks: { [underlyingEvent]: [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: wiredCommand }] }] } },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/custom-events/:name', (req, res) => {
  const cfg = loadConfig();
  const ev = (cfg.customEvents || []).find(e => e.name === req.params.name);
  if (!ev) return res.status(404).json({ error: 'Custom event not found' });
  try {
    // unwire from settings.json
    const settingsPath = join(claudeDir, 'settings.json');
    const settings = readJson(settingsPath);
    if (settings.hooks?.[ev.underlyingEvent]) {
      settings.hooks[ev.underlyingEvent] = settings.hooks[ev.underlyingEvent]
        .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !(h.command || '').includes(ev.filename)) }))
        .filter(g => (g.hooks || []).length);
      if (!settings.hooks[ev.underlyingEvent].length) delete settings.hooks[ev.underlyingEvent];
      writeJson(settingsPath, settings);
    }
    // delete the script
    try { unlinkSync(join(claudeDir, 'hooks', ev.filename)); } catch {}
    // drop from registry
    cfg.customEvents = cfg.customEvents.filter(e => e.name !== ev.name);
    saveConfig(cfg);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API: Saved Workflows (registry for AI-created workflows) ---

app.get('/api/workflows', (req, res) => {
  res.json(loadConfig().workflows || []);
});

app.post('/api/workflows', (req, res) => {
  const { name, title = '', description = '', components = [], setupGuide = [] } = req.body;
  if (!name || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) return res.status(400).json({ error: 'name must be kebab-case' });
  if (!Array.isArray(components) || !components.length) return res.status(400).json({ error: 'components array is required' });
  const cfg = loadConfig();
  cfg.workflows = (cfg.workflows || []).filter(w => w.name !== name); // upsert
  cfg.workflows.push({
    name, title: title || name, description,
    components: components.map(c => ({
      type: c.type, name: c.name, description: c.description || '',
      ...(c.event ? { event: c.event } : {}), ...(c.matcher ? { matcher: c.matcher } : {}),
    })),
    setupGuide,
    createdAt: new Date().toISOString(),
  });
  saveConfig(cfg);
  res.status(201).json({ ok: true, name });
});

app.delete('/api/workflows/:name', (req, res) => {
  const cfg = loadConfig();
  const before = (cfg.workflows || []).length;
  cfg.workflows = (cfg.workflows || []).filter(w => w.name !== req.params.name);
  if (cfg.workflows.length === before) return res.status(404).json({ error: 'Workflow not found' });
  saveConfig(cfg);
  res.json({ ok: true });
});

// --- API: Customizable AI prompts ---
// Every system prompt the app sends to an AI is registered here and can be
// overridden by the user (Settings → Prompts). Overrides persist in the
// config; templates must keep their {{TOKENS}} (validated on save).

const PROMPT_DEFS = {
  'skill-generate':        { label: 'Skill generation',                usedBy: 'Generate with AI → Skill',                       def: () => SKILL_SYSTEM_PROMPT,          note: 'The user request is appended after it — keep it ending with "Request: ".' },
  'agent-generate':        { label: 'Agent generation',                usedBy: 'Generate with AI → Agent',                       def: () => AGENT_SYSTEM_PROMPT,          note: 'Keep it ending with "Request: ".' },
  'command-generate':      { label: 'Command generation',              usedBy: 'Generate with AI → Command; Commands → ✨',      def: () => COMMAND_SYSTEM_PROMPT,        note: 'Keep it ending with "Request: ".' },
  'hook-generate-node':    { label: 'Hook generation — Node.js',       usedBy: 'Generate with AI → Hook (.mjs/.js); Add-Hook ✨', def: () => HOOK_SYSTEM_PROMPT,           note: 'Keep it ending with "Request: ".', tokens: ['{{EVENTS}}'] },
  'hook-generate-python':  { label: 'Hook generation — Python',        usedBy: 'Generate with AI → Hook (.py)',                  def: () => HOOK_SYSTEM_PROMPT_PYTHON,    note: 'Keep it ending with "Request: ".', tokens: ['{{EVENTS}}'] },
  'hook-generate-bash':    { label: 'Hook generation — Bash',          usedBy: 'Generate with AI → Hook (.sh)',                  def: () => HOOK_SYSTEM_PROMPT_BASH,      note: 'Keep it ending with "Request: ".', tokens: ['{{EVENTS}}'] },
  'skill-creator-builtin': { label: 'Built-in skill-creator methodology', usedBy: 'Generate → skill-creator method (when none installed)', def: () => OFFICIAL_SKILL_CREATOR_CONTENT, note: 'Keep it ending with "Request: ". 2025 snapshot of the official methodology + app addendum — Anthropic\'s current skill-creator plugin adds eval loops; install it for the full experience.' },
  'improve':               { label: 'Improve with AI',                 usedBy: '✨ Improve on skills/agents/hooks',              def: () => IMPROVE_PROMPT_TEMPLATE,      tokens: ['{{TYPE}}', '{{TYPE_UPPER}}', '{{PRINCIPLES}}', '{{FEEDBACK}}', '{{VALIDATION}}'] },
  'eval-artifact':         { label: 'Artifact evaluator (self-eval)',  usedBy: 'Generate with AI → 🧪 Evaluate after generating', def: () => EVAL_ARTIFACT_PROMPT_TEMPLATE, tokens: ['{{TYPE}}'], note: 'Bounded: 2 evaluations + 1 revision max per generation — it can never loop.' },
  'explain':               { label: 'Explain with AI',                 usedBy: '🤖 Explain everywhere',                          def: () => EXPLAIN_SYSTEM_PROMPT },
  'workflow-plan':         { label: 'Workflow planning',               usedBy: 'Workflows → ✨ Create with AI (plan step)',      def: () => WORKFLOW_PLAN_PROMPT },
  'compose-workflow':      { label: 'Compose from installed',          usedBy: 'Workflows → 🧬 Compose from Installed',          def: () => COMPOSE_PROMPT },
  'custom-event':          { label: 'Custom event designer',           usedBy: 'Hooks → 🧬 Create Custom Event',                 def: () => CUSTOM_EVENT_PROMPT_TEMPLATE, tokens: ['{{EVENTS}}', '{{LANG_RULES}}', '{{EXT}}'] },
  'suggest-settings':      { label: 'Settings assistant',              usedBy: 'Settings → ✨ Add with AI',                      def: () => SUGGEST_SETTINGS_PROMPT },
};

function getPrompt(id) {
  const overrides = loadConfig().promptOverrides || {};
  return (typeof overrides[id] === 'string' && overrides[id].trim()) ? overrides[id] : PROMPT_DEFS[id].def();
}

// Cheap stable hash (djb2) — used to detect that a built-in default improved
// AFTER the user customized a prompt (their override silently shadows it).
function promptHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

app.get('/api/prompts', (req, res) => {
  const cfg = loadConfig();
  const overrides = cfg.promptOverrides || {};
  const hashes = cfg.promptDefaultHashes || {};
  res.json(Object.entries(PROMPT_DEFS).map(([id, d]) => ({
    id,
    label: d.label,
    usedBy: d.usedBy,
    note: d.note || '',
    tokens: d.tokens || [],
    isCustomized: !!(overrides[id] && overrides[id].trim()),
    // true = default changed since customization; null = customized before we
    // started recording hashes (unknown); false = in sync or not customized
    defaultChanged: (overrides[id] && overrides[id].trim())
      ? (hashes[id] ? promptHash(d.def()) !== hashes[id] : null)
      : false,
    default: d.def(),
    current: getPrompt(id),
  })));
});

app.put('/api/prompts/:id', (req, res) => {
  const def = PROMPT_DEFS[req.params.id];
  if (!def) return res.status(404).json({ error: 'Unknown prompt id' });
  const { content } = req.body;
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'content is required (use reset to restore the default)' });
  const missing = (def.tokens || []).filter(t => !content.includes(t));
  if (missing.length) return res.status(400).json({ error: `This prompt is a template — it must keep the placeholder${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` });
  const cfg = loadConfig();
  cfg.promptOverrides = cfg.promptOverrides || {};
  cfg.promptOverrides[req.params.id] = content;
  // Snapshot the default's hash so we can tell the user when it later improves
  cfg.promptDefaultHashes = cfg.promptDefaultHashes || {};
  cfg.promptDefaultHashes[req.params.id] = promptHash(def.def());
  saveConfig(cfg);
  res.json({ ok: true, isCustomized: true });
});

app.delete('/api/prompts/:id', (req, res) => {
  if (!PROMPT_DEFS[req.params.id]) return res.status(404).json({ error: 'Unknown prompt id' });
  const cfg = loadConfig();
  if (cfg.promptOverrides) delete cfg.promptOverrides[req.params.id];
  if (cfg.promptDefaultHashes) delete cfg.promptDefaultHashes[req.params.id];
  saveConfig(cfg);
  res.json({ ok: true, isCustomized: false });
});

// --- Start ---
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, { shell: true }, () => {});
}

const server = createServer(app);
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log(`  ║  Claude Manager  →  ${url}  ║`);
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║  Folder: ${claudeDir.padEnd(30)} ║`);
  console.log('  ╠══════════════════════════════════════╣');
  console.log('  ║  To use a different folder:          ║');
  console.log('  ║  node server.js /path/to/.claude     ║');
  console.log('  ║  CLAUDE_DIR=/path node server.js     ║');
  console.log('  ╚══════════════════════════════════════╝\n');
  openBrowser(url);
});
