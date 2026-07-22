'use strict';
const { createServer } = require('http');
const { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync, unlinkSync, createWriteStream } = require('fs');
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
const CONFIG_PATH = join(__dirname, 'claude-manager.config.json');
function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(data) {
  try { writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2)); } catch {}
}

// Priority: CLI arg > CLAUDE_DIR env var > saved config > default ~/.claude
function expandHome(p) { return p.replace(/^~(?=[/\\]|$)/, homedir()); }
const cfg = loadConfig();
const initialPath = process.argv[2] || process.env.CLAUDE_DIR || cfg.claudeDir || join(homedir(), '.claude');
let claudeDir = resolve(expandHome(initialPath));

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
  context:     (if skill needs files) Glob patterns auto-loaded as context.

BODY STRUCTURE (Pareto: when_to_use + numbered steps deliver 80% of value):
  - First line: one sentence stating what this skill does and its output.
  - Steps: 3-7 numbered items (Miller's Law). Each step is complete and actionable.
  - Show the exact output format with a realistic example (Humphrey: seeing = understanding).
  - One short edge-case paragraph at the end. No more.

EXAMPLE of a production-quality skill:

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
---

Now produce the SKILL.md content for the following request.
STRICT RULES — violation means failure:
- Output ONLY the raw markdown text. Your response IS the file content.
- Do NOT use any tools. Do NOT write any files to disk.
- Do NOT explain, summarize, or wrap the output. Start with "---" (the YAML frontmatter fence).

Request: `;

const AGENT_SYSTEM_PROMPT = `You are an expert Claude Code agent author.

A Claude Code agent is a SKILL.md where the description field is routing instructions —
it tells an orchestrating Claude when to delegate and what to expect back.
The body teaches the agent its exact workflow. One agent, one responsibility.

FRONTMATTER (Conway's Law: structure mirrors responsibility):
  name:        kebab-case. The /slash-command and the agent's identity.
  description: ROUTING INSTRUCTIONS. Format: "Use when [trigger]. Does [actions]. Returns [output]."
               The orchestrator reads this to decide delegation. One responsibility only.
  when_to_use: Exact trigger phrases for auto-invocation.
  tools:       Comma-separated. Occam: only tools the agent will actually call.
               Options: Bash, Read, Edit, Write, WebFetch, WebSearch, Agent

BODY STRUCTURE (Pareto: description + first two steps = 80% of agent value):
  - Identity line: "You are a [role] agent. Your single responsibility is [X]."
  - Input section: what the agent receives (args, context, piped data).
  - Steps: 3-7 numbered steps (Miller). Each is concrete and testable.
  - Output contract: exact format returned to the orchestrator.
  - Constraints: what this agent does NOT do (prevents scope creep).

EXAMPLE of a production-quality agent:

---
name: security-auditor
description: >
  Use when the user asks to audit code for security issues, check for vulnerabilities,
  or scan for OWASP issues. Performs static analysis and returns a JSON report with
  severity-ranked findings. Does NOT fix issues — reports only.
when_to_use: >
  Use when user says "security audit", "check for vulnerabilities", "is this secure",
  "OWASP scan", "find security bugs", or "audit my auth".
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
---

Now produce the agent SKILL.md content for the following request.
STRICT RULES — violation means failure:
- Output ONLY the raw markdown text. Your response IS the file content.
- Do NOT use any tools. Do NOT write any files to disk.
- Do NOT explain, summarize, or wrap the output. Start with "---" (the YAML frontmatter fence).

Request: `;

const HOOK_SYSTEM_PROMPT = `You are an expert Claude Code hook author.

A hook is an ESM JavaScript file (.mjs) Claude Code runs at lifecycle events.
Claude pipes JSON to stdin; the hook reads it, acts, then exits with the right code.

HOOK EVENTS:
  PreToolUse   — before Claude calls a tool. Can BLOCK the call.
  PostToolUse  — after a tool completes. Can inject feedback into the transcript.
  Stop         — when Claude is about to stop. Can redirect Claude back to work.
  SessionStart — once when session begins. Good for setup and context injection.

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

FOUR LAWS (non-negotiable):
  1. FAIL-OPEN (Pareto): ALL logic inside try/catch. exit 0 in the catch block.
     A hook that crashes and blocks Claude is worse than a hook that does nothing.
  2. POSTEL (Occam): write JSON to stdout ONLY when sending a control signal.
     Side-effect hooks (logging, notifications) write nothing to stdout.
  3. KIDLIN: name the file after what it prevents or produces.
     GOOD: block-rm-rf.mjs, log-file-writes.mjs  BAD: hook1.mjs, my-hook.mjs
  4. STOP GUARD (Humphrey): Stop hooks that do work will loop forever.
     Always check stop_hook_active and exit 0 immediately when true.

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

Now produce the hook .mjs file content for the following request.
STRICT RULES — violation means failure:
- Output ONLY raw JavaScript. Your response IS the file content.
- Do NOT use any tools. Do NOT write any files to disk.
- Do NOT explain, summarize, or add markdown. Start with "#!/usr/bin/env node".

Request: `;

const HOOK_SYSTEM_PROMPT_PYTHON = `You are an expert Claude Code hook author writing Python 3 hooks.

A hook is a Python 3 script (.py) Claude Code runs at lifecycle events.
Claude pipes JSON to stdin; the hook reads it, acts, then exits with the right code.

HOOK EVENTS:
  PreToolUse   — before Claude calls a tool. Can BLOCK the call.
  PostToolUse  — after a tool completes.
  Stop         — when Claude is about to stop. Can redirect Claude back to work.
  SessionStart — once when session begins.

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

FOUR LAWS (non-negotiable):
  1. FAIL-OPEN: ALL logic inside try/except. sys.exit(0) in the except block.
  2. POSTEL: print JSON to stdout ONLY when sending a control signal.
  3. KIDLIN: name file after what it prevents/produces. block-rm-rf.py, log-writes.py
  4. STOP GUARD: Stop hooks must check stop_hook_active and exit 0 immediately when True.

Output ONLY the raw Python file — start with #!/usr/bin/env python3. No markdown. No explanation.

Request: `;

const HOOK_SYSTEM_PROMPT_BASH = `You are an expert Claude Code hook author writing Bash shell hooks.

A hook is a Bash script (.sh) Claude Code runs at lifecycle events.
Claude pipes JSON to stdin; the hook reads it, acts, then exits with the right code.

NOTE: Bash hooks work on macOS and Linux only. For Windows support, use Node.js (.mjs) or Python (.py).

HOOK EVENTS:
  PreToolUse   — before Claude calls a tool. Can BLOCK the call.
  PostToolUse  — after a tool completes.
  Stop         — when Claude is about to stop.
  SessionStart — once when session begins.

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

FOUR LAWS:
  1. FAIL-OPEN: Always exit 0 on errors. A crashing hook must never block Claude.
  2. POSTEL: printf JSON to stdout ONLY when sending a control signal.
  3. KIDLIN: name file after what it prevents/produces. block-rm-rf.sh, log-writes.sh
  4. STOP GUARD: Always check STOP_ACTIVE and exit 0 immediately when True.

Output ONLY the raw Bash script — start with #!/usr/bin/env bash. No markdown. No explanation.

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
---

# /command-name

One sentence: what this command does and what it outputs.

## Steps

1. 3-7 numbered, concrete steps (Miller's Law). Reference $ARGUMENTS where the
   user's input is needed.
2. Each step is complete and actionable.
3. Show the exact output format with a short realistic example.

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
STRICT RULES — violation means failure:
- Output ONLY the raw markdown text. Your response IS the file content.
- Do NOT use any tools. Do NOT write any files to disk.
- Do NOT explain or wrap the output. Start with "---" (frontmatter) or "# /" (heading).

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
function callClaudeCli(fullPrompt) {
  return new Promise((resolve, reject) => {
    const tmpFile = join(tmpdir(), `claude-skill-${Date.now()}.txt`);
    try { writeFileSync(tmpFile, fullPrompt, 'utf8'); } catch (e) { return reject(new Error('Failed to write temp file: ' + e.message)); }
    const cmd = process.platform === 'win32'
      ? `type "${tmpFile.replace(/"/g, '\\"')}" | claude -p --dangerously-skip-permissions --allowedTools ""`
      : `cat "${tmpFile.replace(/"/g, '\\"')}" | claude -p --dangerously-skip-permissions --allowedTools ""`;
    exec(cmd, { shell: true, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
  res.json({ valid: existsSync(claudeDir), path: claudeDir });
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
  const plugins = readJson(join(claudeDir, 'plugins', 'installed_plugins.json'));

  const skillCount = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory()).length : 0;
  const hookFileCount = existsSync(hooksDir)
    ? readdirSync(hooksDir).filter(f => HOOK_EXTS.test(f)).length : 0;
  const hookEventCount = Object.keys(settings.hooks || {}).length;
  const pluginCount = Object.keys((plugins.plugins) || {}).length;
  const enabledPluginCount = Object.values(plugins.enabledPlugins || {}).filter(Boolean).length;
  const commandCount = existsSync(commandsDir)
    ? readdirSync(commandsDir).filter(f => f.endsWith('.md')).length : 0;
  const agentsDir = join(claudeDir, 'agents');
  const agentCount = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter(f => f.endsWith('.md')).length : 0;

  res.json({
    path: claudeDir,
    skills: skillCount,
    hookFiles: hookFileCount,
    hookEvents: hookEventCount,
    plugins: pluginCount,
    enabledPlugins: enabledPluginCount,
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

app.get('/api/settings', (req, res) => {
  res.json(readJson(join(claudeDir, 'settings.json')));
});

app.put('/api/settings', (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings object required' });
  writeJson(join(claudeDir, 'settings.json'), settings);
  res.json({ ok: true });
});

// --- API: Skills ---

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
  creators.push({ name: 'skill-creator (Built-in)', content: OFFICIAL_SKILL_CREATOR_CONTENT, official: true, builtin: true });
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

app.get('/api/plugins', (req, res) => {
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
  const addMcpServers = (servers, configFile) => {
    Object.entries(servers || {}).forEach(([id, cfg]) => {
      if (knownIds.has(id)) return;
      knownIds.add(id);
      result.push({
        id, isMcpServer: true,
        description: describeMcpServer(id, cfg),
        version: null,
        scope: 'user',
        installedAt: null,
        lastUpdated: null,
        enabled: true,
        mcpType: cfg.type || 'stdio',
        mcpCommand: cfg.command || cfg.url || '',
        configFile,
      });
    });
  };
  addMcpServers(settings.mcpServers, 'settings.json');
  collectGlobalMcpServers().forEach(({ id, cfg, configFile, scope }) => {
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

  res.json(result);
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
  const { prompt, provider, type = 'skill', creatorContent, hookLang } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'prompt is required' });
  let fullPrompt;
  if (creatorContent?.trim()) {
    // If the content already ends with "Request:" (official skill-creator format), append directly.
    // NB: compare after trimEnd() WITHOUT a trailing space — trimEnd strips it.
    const endsWithRequest = creatorContent.trimEnd().endsWith('Request:');
    fullPrompt = endsWithRequest
      ? creatorContent.trimEnd() + ' ' + prompt.trim()
      : `You are generating a Claude Code ${type} using the methodology below.\n\n${creatorContent.trim()}\n\n========\nCRITICAL: Your response must be ONLY the raw file content with zero preamble or explanation.\nFor skill/agent the very first characters must be "---" (YAML frontmatter). Do NOT write anything before it.\nFor hook the very first line must be a shebang like "#!/usr/bin/env node".\n\nRequest: ${prompt.trim()}`;
  } else {
    const hookPromptMap = { '.mjs': HOOK_SYSTEM_PROMPT, '.js': HOOK_SYSTEM_PROMPT, '.py': HOOK_SYSTEM_PROMPT_PYTHON, '.sh': HOOK_SYSTEM_PROMPT_BASH, '.bash': HOOK_SYSTEM_PROMPT_BASH };
    const promptMap = { skill: SKILL_SYSTEM_PROMPT, agent: AGENT_SYSTEM_PROMPT, command: COMMAND_SYSTEM_PROMPT, hook: (hookLang && hookPromptMap[hookLang]) || HOOK_SYSTEM_PROMPT };
    fullPrompt = (promptMap[type] || SKILL_SYSTEM_PROMPT) + prompt.trim();
  }
  try {
    let content;
    if (provider === 'openrouter') {
      const cfg = loadConfig();
      if (!cfg.openRouterKey) return res.status(400).json({ error: 'OpenRouter API key not configured. Add it in Settings > AI Generation.' });
      content = await callOpenRouter(cfg.openRouterKey, cfg.openRouterModel || 'anthropic/claude-sonnet-4-5', '', fullPrompt);
    } else {
      if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found. Install Claude Code or use OpenRouter instead.' });
      content = await callClaudeCli(fullPrompt);
    }
    content = content.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();

    // For skill/agent: strip any leading prose before the first YAML frontmatter block
    if (type === 'skill' || type === 'agent') {
      if (!content.startsWith('---')) {
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

    res.json({ content, type });
  } catch (e) {
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

Now produce the SKILL.md for the following request.
Output ONLY the raw file content — start with "---" (YAML frontmatter). No explanation.

Request: `;


const IMPROVE_PROMPT = (type, feedback) => {
  const feedbackSection = feedback
    ? `User feedback (what needs fixing/improving):\n${feedback}\n\nIncorporate this feedback precisely.\n\n`
    : 'Apply best practices: sharpen trigger phrases, tighten steps (max 7), remove filler, improve the output example to be concrete and realistic.\n\n';
  const validation = (type === 'skill' || type === 'agent')
    ? 'Output ONLY the raw improved file content. Start with "---" (YAML frontmatter). No explanation.'
    : 'Output ONLY the raw improved code. Start with "#!/usr/bin/env node". No explanation.';
  return `You are an expert Claude Code ${type} author improving an existing ${type}.

Principles to apply:
- Pareto: clear trigger phrases + concrete numbered steps = 80% of value. Maximise these.
- Occam: cut anything the user won't miss (vague intros, redundant steps, filler sentences).
- Miller: cap at 7 steps. Merge overlapping ones; split only if a step is secretly two actions.
- Kidlin: if a step can't be written simply, rewrite it until it can.
- Humphrey: show a realistic output example so the user sees exactly what they'll get.

${feedbackSection}${validation}

ORIGINAL ${type.toUpperCase()} TO IMPROVE:
`;
};

// (The /api/skills/creators route is registered above /api/skills/:name — see Skills section.)

app.post('/api/ai/improve-skill', async (req, res) => {
  const { type = 'skill', content, feedback, provider } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
  const fullPrompt = IMPROVE_PROMPT(type, feedback?.trim() || null) + content.trim();
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
    improved = improved.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
    res.json({ content: improved, type });
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
      return { name: f.replace(/\.md$/, ''), content, size: formatSize(stat.size), modified: stat.mtime.toISOString() };
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

Shape:
{
  "name": "kebab-case-name",
  "title": "Human Readable Title",
  "description": "One sentence — what this workflow accomplishes and who benefits.",
  "setupGuide": ["plain text step 1", "plain text step 2", "plain text step 3"],
  "components": [
    { "type": "skill"|"agent"|"hook"|"command", "name": "kebab-case-name", "description": "One sentence — this component's specific role." }
  ]
}

RULES (no exceptions):
- components array: ONLY name/type/description — NO content field
- Pareto: pick the vital-few components that deliver 80% of the value
- Occam: if 2 components cover the goal, don't add a third
- Miller: max 6 components total
- All names: lowercase-hyphens only, unique within the workflow
- setupGuide: 3–5 concise plain-text steps that explain how to activate and use the workflow
`;

app.post('/api/ai/generate-workflow-plan', async (req, res) => {
  const { goal, context, provider } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: 'goal is required' });
  const contextBlock = context?.trim() ? `\nAdditional context:\n${context.trim()}\n` : '';
  const fullPrompt = WORKFLOW_PLAN_PROMPT + contextBlock + '\nGoal: ' + goal.trim();
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
    res.json(plan);
  } catch (e) {
    if (e instanceof SyntaxError) return res.status(500).json({ error: 'AI returned invalid JSON. Try again.' });
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
    for (const full of walkFiles(hooksDir)) {
      if (HOOK_EXTS.test(full)) inv.hooks.push({ name: relPath(hooksDir, full) });
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

const COMPOSE_PROMPT = `You are a Claude Code workflow architect. The user wants a workflow.
Decide whether it can be composed from the ALREADY-INSTALLED resources in the inventory below.
Prefer reusing existing resources; only propose new ones when nothing installed fits.

Output ONLY raw JSON — no prose, no markdown fences:
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
`;

app.post('/api/ai/compose-workflow', async (req, res) => {
  const { goal, provider } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: 'goal is required' });
  const inventory = collectInventory();
  const total = inventory.skills.length + inventory.agents.length + inventory.hooks.length + inventory.commands.length;
  if (!total) return res.status(400).json({ error: 'Nothing is installed yet — add some skills, agents, hooks, or commands first, or use "Create with AI" to generate a full workflow from scratch.' });

  const fullPrompt = COMPOSE_PROMPT
    + '\nINVENTORY OF INSTALLED RESOURCES:\n' + JSON.stringify(inventory, null, 1)
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
    res.json({
      feasible: plan.feasible && ['yes', 'partial', 'no'].includes(plan.feasible) ? (missing.length && plan.feasible === 'yes' ? 'partial' : plan.feasible) : feasible,
      summary: plan.summary || '',
      components, missing,
      setupGuide: Array.isArray(plan.setupGuide) ? plan.setupGuide : [],
      inventoryCounts: { skills: inventory.skills.length, agents: inventory.agents.length, hooks: inventory.hooks.length, commands: inventory.commands.length },
    });
  } catch (e) {
    if (e instanceof SyntaxError) return res.status(500).json({ error: 'AI returned invalid JSON. Try again or rephrase the goal.' });
    res.status(500).json({ error: e.message });
  }
});

// --- AI: Workflow & Explain system prompts ---

const WORKFLOW_SYSTEM_PROMPT = `You are an expert Claude Code workflow architect.
Output ONLY a single raw JSON object — no prose, no markdown fences, no explanation.

JSON shape:
{
  "name": "kebab-case-name",
  "title": "Human Readable Title",
  "description": "One sentence describing what the workflow does and who benefits.",
  "setupGuide": ["step 1 plain text", "step 2 plain text", "step 3 plain text"],
  "components": [ ...Component ]
}

Component shape:
{
  "type": "skill" | "agent" | "hook" | "command",
  "name": "kebab-case-name",
  "description": "One sentence describing this component's role.",
  "content": "...file content..."
}

Content rules (STRICT — violations invalidate the output):
- skill/agent: MUST start with "---" (YAML frontmatter), use all relevant fields (name, description, trigger for skills; name, description, model for agents)
- hook: MUST start with "#!/usr/bin/env node" and use readline+stdin protocol (process.stdin / rl.on('line'))
- command: plain markdown with a # heading and usage instructions
- All names: lowercase, hyphens only (no spaces, no underscores)

Design laws to apply:
- Pareto: pick the 20% of components that deliver 80% of the goal's value
- Occam: if a goal can be met with 2 components, don't add a third
- Miller: cap at 6 components total
- Kidlin: make each component's purpose unambiguous from its description alone

Goal: `;

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

app.post('/api/ai/generate-workflow', async (req, res) => {
  const { goal, provider } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: 'goal is required' });
  const fullPrompt = WORKFLOW_SYSTEM_PROMPT + goal.trim();
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
    const workflow = JSON.parse(json);
    if (!Array.isArray(workflow.components) || !workflow.components.length) {
      return res.status(500).json({ error: 'AI returned an invalid workflow structure — try rephrasing your goal.' });
    }
    res.json(workflow);
  } catch (e) {
    if (e instanceof SyntaxError) return res.status(500).json({ error: 'AI returned invalid JSON. Try again or rephrase the goal.' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ai/explain', async (req, res) => {
  const { content, type, provider } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
  const fullPrompt = EXPLAIN_SYSTEM_PROMPT + `[Type: ${type || 'unknown'}]\n\n${content.trim()}`;
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
  Object.keys(settings.mcpServers || {}).forEach(k => keys.add(k.toLowerCase()));
  collectGlobalMcpServers().forEach(({ id }) => keys.add(id.toLowerCase()));
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

function buildRunPrompt(kind, name, task) {
  const t = (task || '').trim();
  if (kind === 'skill' || kind === 'command') return (`/${name} ${t}`).trim();
  if (kind === 'agent') {
    return `Read the agent definition at ${join(claudeDir, 'agents', name + '.md')} and act as that agent. `
         + `Follow its steps, tool constraints, and output contract exactly.`
         + (t ? `\n\nTask: ${t}` : '\n\nTask: perform the agent\'s default responsibility on the current directory.');
  }
  // workflow: free-form goal
  return t || `Execute the "${name}" workflow on the current directory.`;
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
    // Copy-paste command to run the exact same one-shot manually in a terminal
    manualCommand: `claude -p ${shellQuote(examplePrompt)} --dangerously-skip-permissions --output-format stream-json --verbose > run-output.jsonl`,
  });
});

app.post('/api/run/start', (req, res) => {
  const { kind = 'skill', name, task = '', outputFile, cwd, provider = 'claude-cli' } = req.body;
  if (!name || !/^[a-zA-Z0-9 _-]+$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
  if (!RUN_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be one of: ' + RUN_KINDS.join(', ') });
  if (!outputFile?.trim()) return res.status(400).json({ error: 'outputFile is required — where should the JSONL stream be written?' });

  let file = resolve(expandHome(outputFile.trim()));
  if (!/\.jsonl$/i.test(file)) file += '.jsonl';
  let workDir = cwd?.trim() ? resolve(expandHome(cwd.trim())) : homedir();
  if (!existsSync(workDir)) return res.status(400).json({ error: 'Working directory not found: ' + workDir });
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
      prompt: (task || '').trim() || 'Perform your default responsibility.',
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
        run.running = false; run.exitCode = 0; run.finishedAt = new Date().toISOString();
        try { ws2.end(); } catch {}
      })
      .catch(e => {
        emit({ type: 'result', subtype: 'error', error: e.message });
        run.running = false; run.exitCode = 1; run.error = e.message; run.finishedAt = new Date().toISOString();
        try { ws2.end(); } catch {}
      });
    return res.json({ ok: true, id, file, provider: 'openrouter', prompt: run.prompt, note: 'Text-only run — no local tools are executed.' });
  }

  // ── Claude CLI provider: full run with all permissions ──
  if (!claudeCliAvailable) return res.status(400).json({ error: 'Claude CLI not found. Install Claude Code, or switch the provider to OpenRouter for a text-only run.' });

  const prompt = buildRunPrompt(kind, name, task);
  const cmd = 'claude -p --dangerously-skip-permissions --output-format stream-json --verbose';

  let ws;
  try { ws = createWriteStream(file, { flags: 'a' }); } catch (e) { return res.status(400).json({ error: 'Cannot write output file: ' + e.message }); }

  const child = spawn(cmd, { shell: true, cwd: workDir });
  const run = {
    id, kind, name, file, prompt, cwd: workDir,
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
  child.on('error', e => { run.running = false; run.error = e.message; clearTimeout(killTimer); try { ws.end(); } catch {} });
  child.on('close', code => {
    if (partial.trim()) { run.lines++; run.tail.push(partial.slice(0, 400)); }
    run.running = false;
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    clearTimeout(killTimer);
    try { ws.end(); } catch {}
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
