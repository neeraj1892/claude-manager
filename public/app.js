// Claude Manager SPA — v2

// ===== MONACO =====
let monacoReady = false;
const editorInstances = {};

require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
require(['vs/editor/editor.main'], () => {
  monacoReady = true;
  monaco.editor.defineTheme('claude-dark', {
    base: 'vs-dark', inherit: true, rules: [],
    colors: {
      'editor.background': '#1e1e2e', 'editor.foreground': '#cdd6f4',
      'editorLineNumber.foreground': '#45475a', 'editor.lineHighlightBackground': '#252538',
      'editorCursor.foreground': '#7c6af7', 'editor.selectionBackground': '#3a3a5c',
      'editorGutter.background': '#1e1e2e',
    },
  });
  monaco.editor.defineTheme('claude-light', {
    base: 'vs', inherit: true, rules: [],
    colors: { 'editor.background': '#f5f5fc', 'editor.foreground': '#1a1a2e' },
  });
  applyMonacoTheme();
  initPendingEditors();
});

function applyMonacoTheme() {
  if (!monacoReady) return;
  monaco.editor.setTheme(document.body.classList.contains('light') ? 'claude-light' : 'claude-dark');
}

function createEditor(containerId, language, value) {
  if (!monacoReady) return null;
  const el = document.getElementById(containerId);
  if (!el) return null;
  if (editorInstances[containerId]) editorInstances[containerId].dispose();
  const ed = monaco.editor.create(el, {
    value: value || '', language: language || 'markdown',
    theme: document.body.classList.contains('light') ? 'claude-light' : 'claude-dark',
    automaticLayout: true, minimap: { enabled: false },
    fontSize: 13, lineHeight: 20, padding: { top: 12, bottom: 12 },
    scrollBeyondLastLine: false, wordWrap: 'on',
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    renderLineHighlight: 'line',
  });
  editorInstances[containerId] = ed;
  return ed;
}

// ===== TEMPLATE DATA =====
const TEMPLATES = {
  skill: [
    {
      id: 'inline', name: 'Reference Skill', icon: '📖',
      desc: 'Knowledge Claude applies automatically to your work',
      content: n => `---
name: ${n}
description: >
  Describe when Claude should use this skill.
  Be specific — Claude reads this to decide when to apply it.
when_to_use: >
  Use when the user asks about [topic].
  Also triggered by phrases like "[example phrase]".
---

# ${n}

## Guidelines

Write the conventions, patterns, or knowledge Claude should apply.

- Convention one
- Convention two
`,
    },
    {
      id: 'task', name: 'Task Skill (/slash)', icon: '⌨️',
      desc: 'Step-by-step workflow invoked manually with /name',
      content: n => `---
name: ${n}
description: >
  Performs [describe the task]. Invoke with /${n}.
disable-model-invocation: true
---

# /${n}

When invoked, perform the following steps:

## Steps

1. First step
2. Second step
3. Third step

## Output

Describe the expected output format.
`,
    },
    {
      id: 'fork', name: 'Forked Skill (subagent)', icon: '🔀',
      desc: 'Runs in its own subagent context, not inline',
      content: n => `---
name: ${n}
description: >
  [Describe what this skill does].
  Runs in a forked subagent to keep the main context clean.
context: fork
disable-model-invocation: true
---

# ${n}

## Instructions

This skill runs in a separate subagent. Write instructions as if
addressing that agent directly.

## Steps

1. Step one
2. Step two
`,
    },
    {
      id: 'args', name: 'With Arguments', icon: '💬',
      desc: 'Accepts user-supplied arguments via /name arg1 arg2',
      content: n => `---
name: ${n}
description: >
  [Describe what this skill does with the provided arguments].
argument-hint: [filename] [format]
arguments: filename format
---

# ${n}

Process the file \`$filename\` and output in \`$format\` format.

## Steps

1. Read \`$filename\`
2. Transform to \`$format\`
3. Return the result
`,
    },
    {
      id: 'full', name: 'All Fields', icon: '📋',
      desc: 'Every available frontmatter field with comments',
      content: n => `---
name: ${n}
description: >
  What this skill does and when to use it.
  First sentence is most important — used for truncation.
when_to_use: >
  Additional trigger context — example requests or phrases.
argument-hint: [optional-arg]
arguments: optional-arg
disable-model-invocation: false
context: fork
---

# ${n}

Skill body — write instructions here.
`,
    },
  ],

  agent: [
    {
      id: 'basic', name: 'General Agent', icon: '🤖',
      desc: 'Specialist with all tools available',
      content: n => `---
name: ${n}
description: >
  A specialised agent for [purpose].
  Use when the user needs [specific capability].
---

You are a specialised agent for [purpose].

## Instructions

Describe what this agent does, its focus area, and
the format of its outputs.
`,
    },
    {
      id: 'readonly', name: 'Read-Only Research', icon: '🔍',
      desc: 'Can read and search but cannot write or run shells',
      content: n => `---
name: ${n}
description: >
  Read-only research agent. Searches files and the web
  but cannot write, edit, or run shell commands.
tools: Read, Grep, Glob, WebSearch, WebFetch
disallowedTools: Bash, Write, Edit
---

You are a read-only research agent.
Search, read, and analyse — never write, edit, or execute.

## Instructions

Describe what research tasks this agent handles and how
it should present findings.
`,
    },
    {
      id: 'isolated', name: 'Isolated Worktree', icon: '🔒',
      desc: 'Runs in a separate git worktree — safe for risky changes',
      content: n => `---
name: ${n}
description: >
  Runs in an isolated git worktree so its changes don't affect
  the main working tree until explicitly merged.
isolation: worktree
model: claude-opus-4-7
effort: high
---

You are an isolated agent working in a separate git worktree.

## Instructions

Describe the task. When done, summarise what changed
so the user can review before merging.
`,
    },
    {
      id: 'full', name: 'All Fields', icon: '📋',
      desc: 'Every available frontmatter field with comments',
      content: n => `---
name: ${n}
description: >
  What this agent does and when to spawn it.
model: claude-sonnet-4-6
tools: Read, Write, Bash
disallowedTools: WebSearch
permissionMode: acceptEdits
maxTurns: 20
memory: false
effort: medium
isolation: none
color: blue
---

Agent system prompt here.
`,
    },
  ],

  command: [
    {
      id: 'blank', name: 'Blank', icon: '📄',
      desc: 'Simple instruction command',
      content: n => `# /${n}

When the user invokes /${n}, do the following:

Describe the task instructions here.
`,
    },
    {
      id: 'workflow', name: 'Workflow', icon: '🔄',
      desc: 'Structured step-by-step process',
      content: n => `# /${n}

When invoked, follow this workflow:

## Steps

1. Analyze [X]
2. Then do [Y]
3. Output [Z]

## Output Format

Describe the expected output format.
`,
    },
    {
      id: 'report', name: 'Report Generator', icon: '📊',
      desc: 'Produces a structured project report',
      content: n => `# /${n}

Generate a structured report about the current project.

## Include

- Summary of recent changes
- Current status of key areas
- Issues or warnings found
- Recommended next steps

## Format

Present as a well-structured markdown document.
`,
    },
  ],

  'hook-file': [
    {
      id: 'blank', name: 'Blank', icon: '📄',
      desc: 'Minimal hook skeleton',
      content: n => `#!/usr/bin/env node
// ${n} — Claude Code lifecycle hook

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  try {
    const input = JSON.parse(lines.join('\\n') || '{}');
    // input.tool_name      — which tool fired (Pre/PostToolUse)
    // input.tool_input     — tool arguments object
    // input.tool_response  — tool result (PostToolUse only)

    // TODO: implement hook logic here

    // Allow the action to proceed:
    // process.stdout.write(JSON.stringify({ continue: true }));
  } catch {}
});
`,
    },
    {
      id: 'formatter', name: 'PostToolUse Formatter', icon: '✨',
      desc: 'Runs a formatter after Edit or Write',
      content: n => `#!/usr/bin/env node
// ${n} — Auto-format files after Edit/Write
// Register under: hooks.PostToolUse  matcher: Edit (or Write)

import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  try {
    const { tool_input } = JSON.parse(lines.join('\\n') || '{}');
    const file = tool_input?.file_path;
    if (!file) return;

    if (file.endsWith('.py'))
      execSync(\`ruff format "\${file}"\`, { stdio: 'pipe' });
    else if (/\\.(js|ts|jsx|tsx|json|css)$/.test(file))
      execSync(\`prettier --write "\${file}"\`, { stdio: 'pipe' });
    else if (file.endsWith('.go'))
      execSync(\`gofmt -w "\${file}"\`, { stdio: 'pipe' });
    else if (file.endsWith('.rs'))
      execSync(\`rustfmt "\${file}"\`, { stdio: 'pipe' });
  } catch {
    // Silent — never block Claude on formatter errors
  }
});
`,
    },
    {
      id: 'session-init', name: 'SessionStart Init', icon: '🚀',
      desc: 'Runs environment checks on session start',
      content: n => `#!/usr/bin/env node
// ${n} — Setup checks when Claude Code session starts
// Register under: hooks.SessionStart

import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  try {
    const input = JSON.parse(lines.join('\\n') || '{}');

    // Example: warn if required file is missing
    // if (!existsSync('.env')) process.stderr.write('Warning: .env missing\\n');

    // Signal the session can start:
    process.stdout.write(JSON.stringify({ continue: true }));
  } catch {}
});
`,
    },
    {
      id: 'guard', name: 'PreToolUse Guard', icon: '🛡️',
      desc: 'Blocks or validates tool calls before they run',
      content: n => `#!/usr/bin/env node
// ${n} — Validate tool calls before execution
// Register under: hooks.PreToolUse  matcher: Write (or Bash, Edit...)

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  try {
    const { tool_name, tool_input } = JSON.parse(lines.join('\\n') || '{}');

    // Example: block writes to sensitive system paths
    if (tool_name === 'Write' || tool_name === 'Edit') {
      const forbidden = ['/etc/', '/usr/', '/System/'];
      const file = tool_input?.file_path || '';
      if (forbidden.some(p => file.startsWith(p))) {
        process.stderr.write(\`Blocked: write to \${file}\\n\`);
        process.exit(1); // non-zero exit blocks the tool call
      }
    }

    // Allow by default:
    process.stdout.write(JSON.stringify({ continue: true }));
  } catch {}
});
`,
    },
  ],
};

// ===== FIELD REFERENCE DATA =====
const FIELD_REF = {
  skill: {
    title: 'SKILL.md — Frontmatter Reference',
    fields: [
      { name: 'name',                    req: false, type: 'string',          desc: 'Display name shown in listings. Defaults to the skill directory name.',                                                                                              ex: 'api-conventions' },
      { name: 'description',             req: 'rec', type: 'string',          desc: 'What it does and when to use it. Claude reads this to decide when to apply the skill. Put the key use case first. Combined with when_to_use, truncated at 1,536 chars.', ex: 'Summarises uncommitted changes and flags risky edits.' },
      { name: 'when_to_use',             req: false, type: 'string',          desc: 'Extra trigger phrases or example requests that describe when Claude should invoke this skill. Appended to description.',                                               ex: 'Use when the user asks about git changes or diffs.' },
      { name: 'argument-hint',           req: false, type: 'string',          desc: 'Hint shown in /name autocomplete to indicate expected arguments.',                                                                                                   ex: '[issue-number]  or  [filename] [format]' },
      { name: 'arguments',               req: false, type: 'string | list',   desc: 'Named positional arguments for $name substitution in the skill body. Space-separated string or YAML list. Names map to argument positions in order.',                ex: 'filename format' },
      { name: 'disable-model-invocation',req: false, type: 'boolean',         desc: 'Set true to prevent Claude from automatically loading this skill. Useful for manual-only workflows — the user invokes with /name.',                                   ex: 'true' },
      { name: 'context',                 req: false, type: 'string',          desc: 'Set to "fork" to run this skill inside its own subagent instead of inline in the current session.',                                                                   ex: 'fork' },
    ],
    note: 'Skills can also include supporting files (templates, example outputs, scripts). Reference them from SKILL.md so Claude knows to load them.',
  },
  agent: {
    title: 'Agent — Frontmatter Reference',
    fields: [
      { name: 'name',           req: false, type: 'string',        desc: 'Agent identifier shown in listings. Defaults to the filename.',                                                                   ex: 'code-reviewer' },
      { name: 'description',   req: true,  type: 'string',        desc: 'What the agent does and when to use it. Claude uses this to decide when to spawn this agent. Be specific.',                       ex: 'Reviews code and suggests improvements. Use after writing code.' },
      { name: 'model',          req: false, type: 'string',        desc: 'Claude model for this agent. Defaults to the session model.',                                                                     ex: 'claude-opus-4-7  or  sonnet' },
      { name: 'tools',          req: false, type: 'string | list', desc: 'Comma-separated or YAML list of allowed tools. Omit to allow all tools.',                                                        ex: 'Read, Grep, Glob' },
      { name: 'disallowedTools',req: false, type: 'string | list', desc: 'Tools this agent may never use, even if normally allowed.',                                                                      ex: 'Bash, Write' },
      { name: 'permissionMode', req: false, type: 'string',        desc: '"default" | "acceptEdits" | "bypassPermissions" | "plan". Controls how the agent handles permission prompts.',                   ex: 'acceptEdits' },
      { name: 'maxTurns',       req: false, type: 'number',        desc: 'Maximum agentic turns before the agent stops. Prevents runaway agents.',                                                         ex: '10' },
      { name: 'mcpServers',     req: false, type: 'list',          desc: 'MCP server keys this agent can access (from your settings.json mcpServers).',                                                    ex: '- memory\n  - brave-search' },
      { name: 'memory',         req: false, type: 'boolean',       desc: 'Whether this agent has access to memory tools.',                                                                                  ex: 'false' },
      { name: 'effort',         req: false, type: 'string',        desc: '"low" | "medium" | "high" — controls extended thinking depth for models that support it.',                                       ex: 'high' },
      { name: 'isolation',      req: false, type: 'string',        desc: '"none" | "worktree" — whether to run this agent in an isolated git worktree.',                                                   ex: 'worktree' },
      { name: 'color',          req: false, type: 'string',        desc: 'UI colour for this agent: red, orange, yellow, green, blue, purple, pink.',                                                      ex: 'blue' },
    ],
    note: 'The file body is the agent\'s system prompt. Write it as plain instructions to Claude. The body in the file is equivalent to the "prompt" field when launching agents programmatically.',
  },
  command: {
    title: 'Command — Reference',
    fields: [
      { name: 'filename', req: true, type: 'string', desc: 'The .md filename becomes the slash command. report.md → /report. No frontmatter needed — the entire file content is the instruction.', ex: 'my-cmd.md → /my-cmd' },
    ],
    note: 'Commands support the same frontmatter as skills (name, description, when_to_use, argument-hint, arguments, disable-model-invocation). Files in .claude/commands/ also work.',
  },
  'hook-file': {
    title: 'Hook Script — I/O Reference',
    fields: [
      { name: 'stdin JSON',    req: true,  type: 'object', desc: 'Event context sent as JSON on stdin every time the hook fires. Common fields: session_id, hook_event_name, tool_name (tool events), tool_input (tool args), tool_response (PostToolUse only), cwd, transcript_path.', ex: '{ "tool_name": "Edit", "tool_input": { "file_path": "/src/app.py" } }' },
      { name: 'stdout JSON',   req: false, type: 'object', desc: 'Return JSON to communicate back to Claude Code. For PreToolUse: { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny" } } to block. Return { "continue": true } to allow.', ex: '{ "continue": true }' },
      { name: 'exit code',     req: false, type: 'number', desc: 'Non-zero exit signals failure (logged). For PreToolUse, exit(1) blocks the tool call. Zero or no exit = success.', ex: 'process.exit(1)' },
      { name: 'stderr',        req: false, type: 'string', desc: 'Anything written to stderr is shown in Claude Code\'s debug output. Use for warnings and diagnostic messages.', ex: 'process.stderr.write("Blocked: unsafe path\\n")' },
    ],
    note: 'Hook files are plain .mjs scripts with no frontmatter. Register them in settings.json under hooks.[EventName] as { "type": "command", "command": "/absolute/path/to/hook.mjs" }.',
  },
};

// ===== STATE =====
let currentSection = 'overview';
let settingsData   = {};
let claudeMdContent    = '';
let keybindingsContent = '';
let overlayCallback = null;
let overlayRefType  = null;
let confirmCallback = null;
let hookAddCallback = null;
let _hookGenLang = 'mjs';
let _hookGenContent = '';
let _hookGenFilename = '';
let selectedTemplate   = null;
let currentGalleryType = '';
let refPanelOpen = false;
let currentHookExt  = '.mjs';
let currentHookLang = 'javascript';

const HOOK_RUNTIME_META = {
  '.mjs': { lang: 'javascript', warn: false },
  '.js':  { lang: 'javascript', warn: false },
  '.py':  { lang: 'python',     warn: false },
  '.sh':  { lang: 'shell',      warn: true,  warnMsg: '⚠ Shell scripts (.sh) only run on macOS and Linux. Use Node.js (.mjs) for cross-platform hooks.' },
  '.ps1': { lang: 'powershell', warn: false },
  '.cmd': { lang: 'bat',        warn: true,  warnMsg: '⚠ Batch files (.cmd) only run on Windows. Use Node.js (.mjs) for cross-platform hooks.' },
  '.bat': { lang: 'bat',        warn: true,  warnMsg: '⚠ Batch files (.bat) only run on Windows. Use Node.js (.mjs) for cross-platform hooks.' },
};

const HOOK_RUNTIME_STARTERS = {
  '.mjs': n => `#!/usr/bin/env node\n// ${n} — Claude Code lifecycle hook\n\nimport { createInterface } from 'node:readline';\n\nconst rl = createInterface({ input: process.stdin, terminal: false });\nconst lines = [];\nrl.on('line', l => lines.push(l));\nrl.on('close', () => {\n  try {\n    const input = JSON.parse(lines.join('\\n') || '{}');\n    // input.tool_name      — which tool fired\n    // input.tool_input     — tool arguments object\n    // input.tool_response  — result (PostToolUse only)\n    // input.stop_hook_active — true when re-running due to Stop hook (guard against loops)\n\n    // TODO: implement hook logic here\n\n  } catch {}\n  // Fail-open: exit 0 allows action to proceed\n});\n`,
  '.py':  n => `#!/usr/bin/env python3\n# ${n} — Claude Code lifecycle hook\n# Works on any platform with Python 3 installed.\nimport sys, json\n\ntry:\n    data = json.loads(sys.stdin.read().strip() or '{}')\n    # data.get('tool_name')      — which tool fired\n    # data.get('tool_input')     — tool arguments dict\n    # data.get('tool_response')  — result (PostToolUse only)\n\n    # TODO: implement hook logic here\n\n    sys.exit(0)  # allow action\nexcept Exception:\n    sys.exit(0)  # fail-open: never block Claude on unexpected errors\n`,
  '.sh':  n => `#!/usr/bin/env bash\n# ${n} — Claude Code lifecycle hook\n# WARNING: Shell scripts (.sh) only run on macOS and Linux.\n# For cross-platform hooks, use Node.js (.mjs) instead.\n\nINPUT=$(cat)  # read JSON from stdin\n\n# Parse with python3 (usually available):\n# TOOL=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)\n\n# TODO: implement hook logic here\n\n# Exit 0 = allow, exit 2 = block (PreToolUse only)\nexit 0\n`,
  '.ps1': n => `#!/usr/bin/env pwsh\n# ${n} — Claude Code lifecycle hook\n# Requires PowerShell (pwsh) — available cross-platform if installed.\n\n$raw = [Console]::In.ReadToEnd()\ntry {\n    $data = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { [PSCustomObject]@{} }\n    # $data.tool_name      — which tool fired\n    # $data.tool_input     — tool arguments\n    # $data.tool_response  — result (PostToolUse only)\n\n    # TODO: implement hook logic here\n\n    exit 0  # allow action\n} catch {\n    exit 0  # fail-open\n}\n`,
  '.cmd': n => `@echo off\nREM ${n} — Claude Code lifecycle hook (Windows only)\nREM WARNING: Batch files only run on Windows.\nREM For complex stdin parsing on Windows, use PowerShell (.ps1) instead.\n\nREM Read stdin (limited in cmd.exe):\nset /p INPUT=\n\nREM TODO: implement hook logic here\n\nREM Exit 0 = allow, exit 2 = block (PreToolUse only)\nexit /b 0\n`,
};

function setHookRuntime(ext) {
  currentHookExt  = ext;
  currentHookLang = HOOK_RUNTIME_META[ext]?.lang || 'javascript';
  const isMjs = ext === '.mjs' || ext === '.js';
  const meta  = HOOK_RUNTIME_META[ext] || {};

  document.querySelectorAll('.hook-runtime-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.ext === ext));

  const warnEl = document.getElementById('hookRuntimeWarning');
  if (meta.warn) { warnEl.textContent = meta.warnMsg; warnEl.style.display = ''; }
  else warnEl.style.display = 'none';

  // Update name hint
  const hint = document.querySelector('#templateModal .form-group div');
  if (hint) hint.textContent = `Extension (${ext}) will be added if omitted.`;

  // For non-JS runtimes show only blank template, with runtime-appropriate starter
  if (isMjs) {
    renderTemplateCards(TEMPLATES['hook-file']);
  } else {
    const runtimeBlank = { ...TEMPLATES['hook-file'][0], content: n => (HOOK_RUNTIME_STARTERS[ext] || HOOK_RUNTIME_STARTERS['.mjs'])(n) };
    selectedTemplate = runtimeBlank;
    renderTemplateCards([runtimeBlank]);
  }
}

// ===== API =====
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  // Parse defensively: a 500 with a non-JSON body must surface the real
  // status, not a JSON parse error (Kidlin: report the actual problem).
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText || 'request failed'}`);
  return data;
}

// ===== TOAST =====
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ===== CONFIRM =====
function confirmDlg(title, msg) {
  return new Promise(resolve => {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMsg').textContent   = msg;
    document.getElementById('confirmOverlay').classList.add('open');
    confirmCallback = resolve;
  });
}
document.getElementById('confirmCancel').onclick = () => { document.getElementById('confirmOverlay').classList.remove('open'); confirmCallback && confirmCallback(false); };
document.getElementById('confirmOk').onclick     = () => { document.getElementById('confirmOverlay').classList.remove('open'); confirmCallback && confirmCallback(true); };

// ===== THEME =====
(function initTheme() {
  if (localStorage.getItem('cm-theme') === 'light') {
    document.body.classList.add('light');
    document.getElementById('themeToggle').textContent = '☀️';
  }
})();
document.getElementById('themeToggle').onclick = () => {
  const isLight = document.body.classList.toggle('light');
  localStorage.setItem('cm-theme', isLight ? 'light' : 'dark');
  document.getElementById('themeToggle').textContent = isLight ? '☀️' : '🌙';
  applyMonacoTheme();
};

// ===== NAVIGATION =====
document.querySelectorAll('.nav-item').forEach(btn => { btn.onclick = () => navigate(btn.dataset.section); });

function navigate(section) {
  if (claudeMdDirty && currentSection === 'claude-md' && section !== 'claude-md') {
    if (!window.confirm('CLAUDE.md has unsaved changes. Leave anyway?')) return;
    setClaudeMdDirty(false);
  }
  currentSection = section;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.section === section));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === 'section-' + section));
  loadSection(section);
}

function loadSection(s) {
  ({ overview: loadOverview, 'claude-md': loadClaudeMd, settings: loadSettings,
     hooks: loadHooks, skills: loadSkills, agents: loadAgents, plugins: loadPlugins,
     commands: loadCommands, keybindings: loadKeybindings, examples: loadExamples,
     workflows: loadWorkflows }[s] || (() => {}))();
}

// ===== FOLDER =====
document.getElementById('folderBar').onclick = () => {
  document.getElementById('folderInput').value = document.getElementById('folderPath').textContent;
  document.getElementById('folderOverlay').classList.add('open');
};
document.getElementById('folderCancel').onclick  = () => document.getElementById('folderOverlay').classList.remove('open');
document.getElementById('folderConfirm').onclick = async () => {
  const p = document.getElementById('folderInput').value.trim();
  if (!p) return;
  try {
    const r = await api('POST', '/folder', { path: p });
    document.getElementById('folderPath').textContent = r.path;
    document.getElementById('folderOverlay').classList.remove('open');
    toast('Folder: ' + r.path);
    checkFolderValid();
    loadSection(currentSection); loadBadges();
  } catch (e) { toast(e.message, 'error'); }
};

function setFolderBanner(valid, path) {
  const banner = document.getElementById('folder-banner');
  const bar = document.getElementById('folderBar');
  if (valid) {
    banner.style.display = 'none';
    bar.classList.remove('invalid');
  } else {
    document.getElementById('folder-banner-msg').innerHTML =
      `Folder not found: <code>${escHtml(path)}</code> — choose a valid <code>.claude</code> directory to continue.`;
    banner.style.display = 'flex';
    bar.classList.add('invalid');
  }
}

async function checkFolderValid() {
  try {
    const s = await api('GET', '/status');
    setFolderBanner(s.valid, s.path);
    return s.valid;
  } catch { return false; }
}
document.getElementById('folderInput').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('folderConfirm').click(); });
document.getElementById('refreshBtn').onclick = () => { loadSection(currentSection); loadBadges(); toast('Refreshed', 'info'); };

// ===== BADGES =====
async function loadBadges() {
  try {
    const d = await api('GET', '/overview');
    document.getElementById('badge-skills').textContent   = d.skills;
    document.getElementById('badge-hooks').textContent    = d.hookEvents;
    document.getElementById('badge-plugins').textContent  = d.plugins;
    document.getElementById('badge-commands').textContent = d.commands;
    document.getElementById('badge-agents').textContent   = d.agents || 0;
    document.getElementById('folderPath').textContent     = d.path;
    setFolderBanner(true, d.path);
  } catch { checkFolderValid(); }
}

// ===== OVERVIEW =====
async function loadOverview() {
  try {
    const d = await api('GET', '/overview');
    document.getElementById('overview-path').textContent = d.path;
    const pluginsSub = (d.plugins || 0) > 0 ? `${d.enabledPlugins || 0} enabled · ${(d.plugins || 0) - (d.enabledPlugins || 0)} disabled` : 'none installed';
    document.getElementById('stat-grid').innerHTML = [
      { v: d.skills || 0,      label: 'Skills',       s: 'skills',   icon: '🧩' },
      { v: d.agents || 0,      label: 'Agents',       s: 'agents',   icon: '🤖' },
      { v: d.hookEvents || 0,  label: 'Hook Events',  s: 'hooks',    icon: '🔗' },
      { v: d.plugins || 0,     label: 'Plugins',      s: 'plugins',  icon: '🧱', sub: pluginsSub },
      { v: d.mcpServers || 0,  label: 'MCP Servers',  s: 'plugins',  icon: '🔌' },
      { v: d.commands || 0,    label: 'Commands',     s: 'commands', icon: '⌨️' },
    ].map(({ v, label, s, icon, sub }) =>
      `<div class="stat-card" onclick="navigate('${s}')">
        <div class="stat-value">${v}</div>
        <div class="stat-label">${icon} ${label}</div>
        ${sub ? `<div style="font-size:10px;color:var(--text-dim);margin-top:2px">${sub}</div>` : ''}
      </div>`
    ).join('');
    let ai = {};
    try { ai = await api('GET', '/ai-config'); } catch {}
    document.getElementById('overview-info').innerHTML = `
      <div style="font-weight:650;font-size:13px;margin-bottom:12px">System status</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${[
          ['Default model', `<span class="badge badge-accent">${d.model || 'default'}</span>`],
          ['Claude CLI', ai.claudeCli
            ? '<span class="badge badge-success">✓ installed — full AI runs available</span>'
            : '<span class="badge badge-warning">not found — AI features use OpenRouter</span>'],
          ['OpenRouter key', ai.hasOpenRouterKey
            ? '<span class="badge badge-success">✓ configured (stored outside the repo)</span>'
            : '<span class="badge badge-muted">not set — add in Settings → AI Generation</span>'],
          ['CLAUDE.md', `<span class="badge ${d.hasClaudeMd ? 'badge-success' : 'badge-muted'}">${d.hasClaudeMd ? 'Present' : 'Missing — Claude has no global instructions yet'}</span>`],
          ['Keybindings', `<span class="badge ${d.hasKeybindings ? 'badge-success' : 'badge-muted'}">${d.hasKeybindings ? 'Customized' : 'Defaults'}</span>`],
          ['Hook files', `<span class="badge badge-muted">${d.hookFiles || 0} file${d.hookFiles !== 1 ? 's' : ''} · ${d.hookEvents || 0} event${d.hookEvents !== 1 ? 's' : ''} wired</span>`],
        ].map(([k, v]) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><span class="text-muted" style="font-size:13px">${k}</span>${v}</div>`).join('')}
      </div>`;
  } catch (e) { toast('Overview error: ' + e.message, 'error'); }
}

// ===== CLAUDE.MD =====
let claudeMdEditor = null;
let claudeMdDirty  = false;

function setClaudeMdDirty(dirty) {
  claudeMdDirty = dirty;
  const btn = document.getElementById('saveClaudeMd');
  btn.textContent = dirty ? 'Save *' : 'Save';
  btn.classList.toggle('btn-warning', dirty);
}

async function loadClaudeMd() {
  const { content } = await api('GET', '/claude-md');
  claudeMdContent = content;
  setClaudeMdDirty(false);
  if (!claudeMdEditor && monacoReady) {
    claudeMdEditor = createEditor('claude-md-editor-wrap', 'markdown', content);
    claudeMdEditor.onDidChangeModelContent(() => setClaudeMdDirty(true));
    claudeMdEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      document.getElementById('saveClaudeMd').click();
    });
  } else if (claudeMdEditor) {
    claudeMdEditor.setValue(content);
  } else {
    document.getElementById('claude-md-editor-wrap').innerHTML = '<div style="padding:20px;color:var(--text-muted)">Loading editor…</div>';
  }
}
document.getElementById('saveClaudeMd').onclick = async () => {
  if (!claudeMdEditor) return;
  try {
    await api('PUT', '/claude-md', { content: claudeMdEditor.getValue() });
    setClaudeMdDirty(false);
    toast('CLAUDE.md saved');
  } catch (e) { toast(e.message, 'error'); }
};

// ===== SETTINGS =====
let settingsRawEditor = null;
let allowList = [], denyList = [], envVars = {};

// ===== SETTINGS INSPECTOR (Files & Keys) =====
// What each known settings key controls, where it's consumed, and where to edit it.
const SETTINGS_KEY_DOC = {
  // settings.json / settings.local.json
  model:               { what: 'Default Claude model for every session.', edit: 'General tab' },
  hooks:               { what: 'Lifecycle hook wiring — which scripts run on PreToolUse, PostToolUse, Stop, SessionStart…', edit: 'Hooks section' },
  mcpServers:          { what: 'MCP server definitions (tools Claude can call).', edit: 'Plugins → ＋ Add MCP Server' },
  enabledPlugins:      { what: 'Plugin on/off registry, written by `claude plugin install`.', edit: 'Plugins tab toggles' },
  permissions:         { what: 'Tool allow/deny rules — what Claude may do without asking.', edit: 'Permissions tab' },
  env:                 { what: 'Environment variables injected into every Claude session.', edit: 'Env Vars tab' },
  apiKeyHelper:        { what: 'Script that outputs an API key at launch (advanced auth).', edit: 'Raw JSON tab' },
  statusLine:          { what: 'Custom status line command for the terminal UI.', edit: 'Raw JSON tab' },
  outputStyle:         { what: 'Active output style for responses.', edit: 'Raw JSON tab' },
  includeCoAuthoredBy: { what: 'Adds "Co-Authored-By: Claude" to git commits.', edit: 'Raw JSON tab' },
  cleanupPeriodDays:   { what: 'How long chat transcripts are kept before cleanup.', edit: 'Raw JSON tab' },
  alwaysThinkingEnabled: { what: 'Extended thinking on by default.', edit: 'Raw JSON tab' },
  forceLoginMethod:    { what: 'Pins login to claude.ai or console accounts.', edit: 'Raw JSON tab' },
  theme:               { what: 'Terminal UI color theme.', edit: 'Raw JSON tab' },
  verbose:             { what: 'Verbose output in the terminal UI.', edit: 'Raw JSON tab' },
  spinnerTipsEnabled:  { what: 'Tips shown while Claude is working.', edit: 'Raw JSON tab' },
  feedbackSurveyState: { what: 'Internal survey bookkeeping.', edit: 'Managed — leave as-is' },
  // ~/.claude.json
  projects:            { what: 'Per-project state: local-scope MCP servers, history, trust decisions.', edit: 'Managed by Claude Code' },
  numStartups:         { what: 'Launch counter.', edit: 'Managed by Claude Code' },
  installMethod:       { what: 'How Claude Code was installed.', edit: 'Managed by Claude Code' },
  autoUpdates:         { what: 'Whether Claude Code self-updates.', edit: 'Managed by Claude Code' },
  oauthAccount:        { what: 'Your logged-in account.', edit: 'Managed — use `claude login`' },
  userID:              { what: 'Anonymous user identifier.', edit: 'Managed by Claude Code' },
  tipsHistory:         { what: 'Which onboarding tips you have seen.', edit: 'Managed by Claude Code' },
  firstStartTime:      { what: 'First launch timestamp.', edit: 'Managed by Claude Code' },
};

async function loadSettingsInspector() {
  const el = document.getElementById('settings-inspector');
  if (!el) return;
  el.innerHTML = '<div style="padding:20px;color:var(--text-muted)">Reading configuration files…</div>';
  try {
    const { files } = await api('GET', '/settings/inspect');
    el.innerHTML = files.map(f => {
      const status = !f.exists
        ? '<span class="badge badge-muted">not present</span>'
        : f.error
          ? `<span class="badge" style="background:var(--danger-bg);color:var(--danger)" title="${escHtml(f.error)}">✗ invalid JSON</span>`
          : '<span class="badge badge-success">✓ valid</span>';
      const editBtn = !f.exists ? '' : f.id === 'settings'
        ? `<button class="btn btn-secondary btn-sm" onclick="document.querySelector('#settings-tabs [data-tab=raw-json]').click()">Edit raw</button>`
        : f.id === 'settings-local'
          ? `<button class="btn btn-secondary btn-sm" onclick="openFileEditor('settings.local.json')">Edit</button>`
          : f.id === 'keybindings'
            ? `<button class="btn btn-secondary btn-sm" onclick="navigate('keybindings')">Edit</button>`
            : '<span class="badge badge-warning" title="Managed by the Claude Code CLI — edit via claude commands">🔒 managed</span>';
      const rows = f.keys.map(k => {
        const doc = SETTINGS_KEY_DOC[k.key] || {};
        const managed = !f.editable || (doc.edit || '').startsWith('Managed');
        const valueBadge = k.count !== undefined
          ? `<span class="badge badge-muted">${k.count} ${k.type === 'array' ? 'items' : 'entries'}</span>`
          : `<code style="font-size:11px">${escHtml(k.preview ?? k.type)}</code>`;
        return `<tr>
          <td style="font-family:monospace;font-size:12px;font-weight:600;white-space:nowrap">${escHtml(k.key)}</td>
          <td>${valueBadge}</td>
          <td style="font-size:12px;color:var(--text-muted)">${escHtml(doc.what || 'Custom / unrecognized key.')}</td>
          <td style="font-size:11px;white-space:nowrap">${managed
            ? `<span class="badge badge-warning" style="font-size:10px">🔒 ${escHtml(doc.edit || 'managed')}</span>`
            : `<span class="badge badge-success" style="font-size:10px">✎ ${escHtml(doc.edit || 'Raw JSON tab')}</span>`}</td>
        </tr>`;
      }).join('');
      return `
        <div class="card" style="margin-bottom:14px;padding:0;overflow:hidden">
          <div style="display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:${f.exists && f.keys.length ? '1px solid var(--border)' : 'none'}">
            <div style="flex:1;min-width:0">
              <div style="font-weight:650;font-size:14px;display:flex;align-items:center;gap:8px">📄 ${escHtml(f.label)} ${status}
                ${f.size ? `<span style="font-size:11px;color:var(--text-dim);font-weight:400">${f.size}</span>` : ''}</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${escHtml(f.note)}</div>
              <div style="font-size:10px;color:var(--text-dim);font-family:monospace;margin-top:2px">${escHtml(f.path)}</div>
            </div>
            ${editBtn}
          </div>
          ${f.error ? `<div style="padding:10px 16px;font-size:12px;color:var(--danger)">Parse error: ${escHtml(f.error)} — fix it to see the key breakdown.</div>` : ''}
          ${f.exists && f.keys.length ? `
            <table style="width:100%">
              <thead><tr>
                <th style="width:180px">Key</th><th style="width:110px">Value</th><th>What it controls</th><th style="width:170px">Where to change it</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>` : (!f.exists ? '' : f.keys.length === 0 && !f.error ? '<div style="padding:10px 16px;font-size:12px;color:var(--text-dim)">Empty file.</div>' : '')}
        </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<div style="padding:16px;color:var(--danger)">${escHtml(e.message)}</div>`;
  }
}

// ===== SETTINGS "ADD WITH AI" =====
let _saProvider = 'claude-cli';

function setSaProvider(p) {
  _saProvider = p;
  document.getElementById('saProvCli').classList.toggle('active', p === 'claude-cli');
  document.getElementById('saProvOr').classList.toggle('active', p === 'openrouter');
}
document.getElementById('saProvCli').onclick = () => setSaProvider('claude-cli');
document.getElementById('saProvOr').onclick  = () => setSaProvider('openrouter');

document.getElementById('settingsAiBtn').onclick = async () => {
  document.getElementById('settingsAiRequest').value = '';
  document.getElementById('settingsAiSetup').style.display = '';
  document.getElementById('settingsAiReview').style.display = 'none';
  document.getElementById('settingsAiModal').classList.add('open');
  try {
    const cfg = await api('GET', '/ai-config');
    setSaProvider(cfg.claudeCli ? 'claude-cli' : 'openrouter');
  } catch { setSaProvider('claude-cli'); }
  setTimeout(() => document.getElementById('settingsAiRequest').focus(), 60);
};
document.getElementById('settingsAiClose').onclick  = () => document.getElementById('settingsAiModal').classList.remove('open');
document.getElementById('settingsAiCancel').onclick = () => document.getElementById('settingsAiModal').classList.remove('open');
document.getElementById('settingsAiBack').onclick   = () => {
  document.getElementById('settingsAiSetup').style.display = '';
  document.getElementById('settingsAiReview').style.display = 'none';
};
document.querySelectorAll('#settingsAiModal [data-sareq]').forEach(chip => {
  chip.onclick = () => { document.getElementById('settingsAiRequest').value = chip.dataset.sareq; };
});

document.getElementById('settingsAiSuggest').onclick = async () => {
  const request = document.getElementById('settingsAiRequest').value.trim();
  if (!request) { toast('Describe the settings change first', 'error'); return; }
  const btn = document.getElementById('settingsAiSuggest');
  btn.disabled = true; btn.textContent = 'Thinking…';
  try {
    const r = await api('POST', '/ai/suggest-settings', { request, provider: _saProvider });
    document.getElementById('settingsAiExplanation').textContent = r.explanation || 'Proposed change:';
    document.getElementById('settingsAiPatch').value = JSON.stringify(r.patch, null, 2);
    document.getElementById('settingsAiSetup').style.display = 'none';
    document.getElementById('settingsAiReview').style.display = '';
  } catch (e) {
    toast('Suggestion failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Suggest Change';
  }
};

document.getElementById('settingsAiApply').onclick = async () => {
  let patch;
  try { patch = JSON.parse(document.getElementById('settingsAiPatch').value); }
  catch { toast('The patch is not valid JSON — fix it before applying', 'error'); return; }
  const btn = document.getElementById('settingsAiApply');
  btn.disabled = true; btn.textContent = 'Applying…';
  try {
    await api('POST', '/settings/apply-patch', { patch });
    document.getElementById('settingsAiModal').classList.remove('open');
    toast('settings.json updated');
    loadSettings(); // refresh all tabs + inspector
  } catch (e) {
    toast('Apply failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '✓ Apply to settings.json';
  }
};

// ===== UPDATES FROM ANTHROPIC =====
document.getElementById('checkUpdatesBtn').onclick = async () => {
  const btn = document.getElementById('checkUpdatesBtn');
  const out = document.getElementById('updatesResults');
  btn.disabled = true; btn.textContent = 'Checking…';
  out.innerHTML = '<div style="font-size:13px;color:var(--text-muted)">Querying npm registry and Anthropic docs…</div>';
  try {
    const r = await api('GET', '/updates/check');
    document.getElementById('updatesLastChecked').textContent = 'Last checked: ' + new Date(r.checkedAt).toLocaleString();
    const rows = [];

    // Claude Code CLI
    const cli = r.cli || {};
    rows.push(`
      <div class="card" style="display:flex;align-items:center;gap:12px;padding:12px 14px">
        <span style="font-size:18px">⚡</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px">Claude Code CLI</div>
          <div style="font-size:12px;color:var(--text-muted)">
            ${!cli.installed ? 'Not installed' : `Installed: <code>${escHtml(cli.current || '?')}</code>`} ·
            Latest on npm: <code>${escHtml(cli.latest || 'unknown')}</code>
          </div>
        </div>
        ${cli.hasUpdate
          ? '<button class="btn btn-primary btn-sm" id="updateCliBtn">↑ Run claude update</button>'
          : cli.installed
            ? '<span class="badge badge-success">✓ Up to date</span>'
            : '<span class="badge badge-warning">not installed</span>'}
      </div>`);

    // Hook events
    const he = r.hookEvents || {};
    if (he.error) {
      rows.push(`<div class="card" style="padding:12px 14px;font-size:12px;color:var(--danger)">🔗 Hook events: ${escHtml(he.error)}</div>`);
    } else {
      rows.push(`
        <div class="card" style="display:flex;align-items:center;gap:12px;padding:12px 14px">
          <span style="font-size:18px">🔗</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px">Hook event catalog</div>
            <div style="font-size:12px;color:var(--text-muted)">
              This app knows ${he.knownCount} events · docs list ${he.foundCount}
              ${he.newEvents?.length ? ` · <strong style="color:var(--warning)">new: ${he.newEvents.map(escHtml).join(', ')}</strong>` : ''}
            </div>
          </div>
          ${he.newEvents?.length
            ? `<button class="btn btn-primary btn-sm" id="applyHookEventsBtn">+ Add ${he.newEvents.length} to dropdowns</button>`
            : '<span class="badge badge-success">✓ In sync with docs</span>'}
        </div>`);
    }
    rows.push(`<div style="font-size:11px;color:var(--text-dim)">Claude Manager ${escHtml(r.appVersion)} · sources: registry.npmjs.org, docs.claude.com</div>`);
    out.innerHTML = rows.join('');

    document.getElementById('updateCliBtn')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Updating…';
      try { const u = await api('POST', '/updates/cli', {}); toast(u.output || 'Claude Code updated'); btn.click(); }
      catch (err) { toast('Update failed: ' + err.message, 'error'); e.target.disabled = false; e.target.textContent = '↑ Run claude update'; }
    });
    document.getElementById('applyHookEventsBtn')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api('POST', '/updates/hook-events/apply', { events: he.newEvents });
        await syncDynamicHookEvents();
        toast(`${he.newEvents.length} new hook event${he.newEvents.length > 1 ? 's' : ''} added to all dropdowns`);
        btn.click();
      } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
    });
  } catch (e) {
    out.innerHTML = `<div style="font-size:13px;color:var(--danger)">${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '🔄 Check for Updates';
  }
};

// ===== CUSTOMIZABLE AI PROMPTS =====
async function loadPromptsList() {
  const el = document.getElementById('prompts-list');
  if (!el) return;
  el.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px">Loading prompts…</div>';
  try {
    const prompts = await api('GET', '/prompts');
    el.innerHTML = `<div class="list">${prompts.map(p => `
      <div class="list-row">
        <span style="font-size:14px">📝</span>
        <div class="list-main">
          <div class="list-title">${escHtml(p.label)}
            ${p.isCustomized ? '<span class="badge badge-warning" style="font-size:10px;margin-left:6px" title="You have edited this prompt — the built-in default is not being used">✎ customized</span>' : ''}
          </div>
          <div class="list-sub">Used by: ${escHtml(p.usedBy)}${p.tokens.length ? ` · must keep: ${p.tokens.map(escHtml).join(' ')}` : ''}</div>
        </div>
        <button class="icon-act" data-prompt-edit="${escHtml(p.id)}" title="Edit this prompt">✎</button>
        ${p.isCustomized ? `<button class="icon-act danger" data-prompt-reset="${escHtml(p.id)}" title="Reset to the built-in default">↺</button>` : ''}
      </div>`).join('')}</div>`;

    el.querySelectorAll('[data-prompt-edit]').forEach(b => {
      b.onclick = () => {
        const p = prompts.find(x => x.id === b.dataset.promptEdit);
        if (!p) return;
        if (p.tokens.length) toast('Template prompt — keep these placeholders: ' + p.tokens.join(' '), 'info');
        if (p.note) toast(p.note, 'info');
        openOverlay(`Prompt: ${p.label}`, p.current, 'markdown', null, async (content) => {
          await api('PUT', '/prompts/' + encodeURIComponent(p.id), { content });
          toast(`"${p.label}" prompt saved — used from the next generation on`);
          loadPromptsList();
        });
      };
    });
    el.querySelectorAll('[data-prompt-reset]').forEach(b => {
      b.onclick = async () => {
        const p = prompts.find(x => x.id === b.dataset.promptReset);
        if (!await confirmDlg('Reset Prompt', `Restore the built-in default for "${p?.label}"? Your customized version will be discarded.`)) return;
        await api('DELETE', '/prompts/' + encodeURIComponent(b.dataset.promptReset));
        toast('Prompt reset to the built-in default');
        loadPromptsList();
      };
    });
  } catch (e) {
    el.innerHTML = `<div style="padding:16px;color:var(--danger);font-size:13px">${escHtml(e.message)}</div>`;
  }
}

async function loadSettings() {
  loadSettingsInspector();
  loadPromptsList();
  settingsData = await api('GET', '/settings');
  document.getElementById('settings-model').value = settingsData.model || '';
  renderHooksInSettings(settingsData.hooks || {});
  allowList = [...(settingsData.permissions?.allow || [])];
  denyList  = [...(settingsData.permissions?.deny  || [])];
  renderTags('allow-tags', allowList);
  renderTags('deny-tags',  denyList);
  envVars = { ...(settingsData.env || {}) };
  renderEnvVars();
  const raw = JSON.stringify(settingsData, null, 2);
  if (!settingsRawEditor && monacoReady) settingsRawEditor = createEditor('settings-raw-editor', 'json', raw);
  else if (settingsRawEditor) settingsRawEditor.setValue(raw);
  loadAiSettingsTab();
}

async function loadAiSettingsTab() {
  try {
    const cfg = await api('GET', '/ai-config');
    const dot  = document.getElementById('cliStatusDot');
    const txt  = document.getElementById('cliStatusText');
    if (cfg.claudeCli) {
      dot.style.color = 'var(--success)'; txt.textContent = 'Installed and available';
    } else {
      dot.style.color = 'var(--danger)'; txt.textContent = 'Not found in PATH — install Claude Code CLI';
    }
    if (cfg.hasOpenRouterKey) document.getElementById('orApiKey').placeholder = '●●●●●●●● (set — paste to replace)';
    const sel = document.getElementById('orModelSelect');
    if (sel) sel.value = cfg.openRouterModel || 'anthropic/claude-sonnet-4-5';
  } catch {}
}

document.getElementById('saveAiSettings').onclick = async () => {
  const key   = document.getElementById('orApiKey').value.trim();
  const model = document.getElementById('orModelSelect').value;
  try {
    await api('PUT', '/ai-config', { openRouterKey: key || undefined, openRouterModel: model });
    toast('AI settings saved');
    if (key) document.getElementById('orApiKey').value = '';
    loadAiSettingsTab();
  } catch (e) { toast(e.message, 'error'); }
};

document.getElementById('testOrKey').onclick = async () => {
  const key = document.getElementById('orApiKey').value.trim();
  if (!key) { toast('Enter a key first', 'error'); return; }
  const btn = document.getElementById('testOrKey');
  btn.textContent = 'Testing…'; btn.disabled = true;
  try {
    await api('PUT', '/ai-config', { openRouterKey: key });
    await api('POST', '/ai/generate-skill', { prompt: 'A simple test skill that says hello', provider: 'openrouter' });
    toast('OpenRouter key works!');
    document.getElementById('orApiKey').value = '';
    loadAiSettingsTab();
  } catch (e) { toast('Test failed: ' + e.message, 'error'); }
  finally { btn.textContent = 'Test'; btn.disabled = false; }
};

function renderHooksInSettings(hooks) {
  const el = document.getElementById('hooks-settings-ui');
  const events = Object.keys(hooks);
  if (!events.length) { el.innerHTML = '<div class="text-muted" style="padding:12px">No hooks in settings.json. Manage them in the Hooks section.</div>'; return; }
  el.innerHTML = events.map(evt => {
    const cmds = extractCmdsWithMatcher(hooks[evt] || []);
    return `<div class="hook-event" style="margin-bottom:10px">
      <div class="hook-event-header"><span class="hook-event-name">${escHtml(evt)}</span><span class="hook-event-count">${cmds.length} hook(s)</span></div>
      <div class="hook-event-body open">${cmds.map(({ matcher, cmd }) => `
        <div class="hook-command-row">
          <span class="${matcher ? 'hook-matcher-badge' : 'hook-any-badge'}">${matcher || 'any'}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${escHtml(cmd)}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

document.getElementById('settings-tabs').addEventListener('click', e => {
  if (!e.target.matches('.tab')) return;
  document.querySelectorAll('#settings-tabs .tab').forEach(t => t.classList.remove('active'));
  e.target.classList.add('active');
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  document.getElementById('settings-tab-' + e.target.dataset.tab).classList.add('active');
});

document.getElementById('saveSettings').onclick = async () => {
  let settings;
  if (document.querySelector('#settings-tabs .tab.active')?.dataset.tab === 'raw-json' && settingsRawEditor) {
    try { settings = JSON.parse(settingsRawEditor.getValue()); }
    catch { toast('Invalid JSON', 'error'); return; }
  } else {
    settings = { ...settingsData };
    const m = document.getElementById('settings-model').value;
    if (m) settings.model = m; else delete settings.model;
    syncEnvVars();
    settings.permissions = {};
    if (allowList.length) settings.permissions.allow = allowList;
    if (denyList.length)  settings.permissions.deny  = denyList;
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
    if (Object.keys(envVars).length) settings.env = envVars; else delete settings.env;
  }
  try { await api('PUT', '/settings', { settings }); settingsData = settings; toast('Settings saved'); }
  catch (e) { toast(e.message, 'error'); }
};

function renderTags(id, list) {
  const el = document.getElementById(id);
  el.innerHTML = list.map((v, i) => `<span class="tag">${escHtml(v)}<button class="tag-remove" data-i="${i}">×</button></span>`).join('');
  el.querySelectorAll('.tag-remove').forEach(b => { b.onclick = () => { list.splice(+b.dataset.i, 1); renderTags(id, list); }; });
}
document.getElementById('add-allow').onclick = () => { const v = document.getElementById('allow-input').value.trim(); if (v && !allowList.includes(v)) { allowList.push(v); renderTags('allow-tags', allowList); } document.getElementById('allow-input').value = ''; };
document.getElementById('allow-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('add-allow').click(); });
document.getElementById('add-deny').onclick  = () => { const v = document.getElementById('deny-input').value.trim(); if (v && !denyList.includes(v)) { denyList.push(v); renderTags('deny-tags', denyList); } document.getElementById('deny-input').value = ''; };
document.getElementById('deny-input').addEventListener('keydown',  e => { if (e.key === 'Enter') document.getElementById('add-deny').click(); });

function renderEnvVars() {
  const el = document.getElementById('env-var-rows');
  el.innerHTML = Object.entries(envVars).map(([k, v]) => `
    <div class="kv-row">
      <input type="text" class="ev-key" value="${escHtml(k)}" placeholder="KEY" style="max-width:200px;font-family:monospace">
      <input type="text" class="ev-val" value="${escHtml(v)}" placeholder="VALUE">
      <button class="btn btn-danger btn-sm ev-del">×</button>
    </div>`).join('');
  el.querySelectorAll('.ev-del').forEach((b, i) => { b.onclick = () => { delete envVars[Object.keys(envVars)[i]]; renderEnvVars(); }; });
}
document.getElementById('add-env-var').onclick = () => { envVars['NEW_VAR'] = ''; renderEnvVars(); };
function syncEnvVars() {
  envVars = {};
  document.querySelectorAll('#env-var-rows .kv-row').forEach(row => {
    const k = row.querySelector('.ev-key').value.trim();
    if (k) envVars[k] = row.querySelector('.ev-val').value;
  });
}

// ===== HOOKS =====
const ALL_HOOK_EVENTS = [
  'PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest','PermissionDenied',
  'SessionStart','SessionEnd','Setup','UserPromptSubmit',
  'Stop','StopFailure','Notification',
  'SubagentStart','SubagentStop',
  'PreCompact','PostCompact','ConfigChange','CwdChanged','FileChanged',
];

// Merge docs-discovered events (Settings → Updates) into the catalog + dropdowns
async function syncDynamicHookEvents() {
  try {
    const { dynamic } = await api('GET', '/hook-events');
    (dynamic || []).forEach(evt => {
      if (ALL_HOOK_EVENTS.includes(evt)) return;
      ALL_HOOK_EVENTS.push(evt);
      ['hookEventSelect', 'sgWireEvent'].forEach(id => {
        const sel = document.getElementById(id);
        if (sel && ![...sel.options].some(o => o.value === evt)) {
          const opt = document.createElement('option');
          opt.value = evt;
          opt.textContent = `${evt} — added from Anthropic docs update`;
          sel.appendChild(opt);
        }
      });
    });
  } catch {}
}
syncDynamicHookEvents();
// Events where matcher = tool name regex; all others have event-specific matcher semantics
const MATCHER_EVENTS  = new Set(['PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest','PermissionDenied']);

function extractCmdsWithMatcher(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap(g => (g.hooks || []).map(h => ({ matcher: g.matcher || '', cmd: h.command || h.type || '' })));
}

// Hooks sub-tabs — one concern visible at a time
(function () {
  document.querySelectorAll('#hookSubtabs .hook-subtab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('#hookSubtabs .hook-subtab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      ['events', 'files', 'custom', 'elsewhere'].forEach(k => {
        const p = document.getElementById('hook-sub-' + k);
        if (p) p.style.display = k === tab.dataset.hookSub ? '' : 'none';
      });
    };
  });
})();

async function loadHooks() {
  const data = await api('GET', '/hooks');
  if (data.settingsError) toast(data.settingsError, 'error');
  renderHookEvents(data.settings || {});
  // DOET: a hook file's most important state is whether it's WIRED — compute
  // which events reference each file so every row can show it.
  const wiredMap = {};
  Object.entries(data.settings || {}).forEach(([event, groups]) => {
    (groups || []).forEach(g => (g.hooks || []).forEach(h => {
      (data.files || []).forEach(f => {
        if ((h.command || '').includes(f.name)) (wiredMap[f.name] = wiredMap[f.name] || new Set()).add(event);
      });
    }));
  });
  renderHookFiles(data.files || [], wiredMap);
  const customCount = await renderCustomEvents();
  renderElsewhereHooks(data.elsewhere || []);
  const setCount = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  setCount('hsub-count-events', Object.keys(data.settings || {}).length);
  setCount('hsub-count-files', (data.files || []).length);
  setCount('hsub-count-custom', customCount);
  setCount('hsub-count-elsewhere', (data.elsewhere || []).length);
}

// ===== CUSTOM (DERIVED) EVENTS =====
async function renderCustomEvents() {
  const el = document.getElementById('custom-events-list');
  if (!el) return 0;
  try {
    const events = await api('GET', '/custom-events');
    if (!events.length) {
      el.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:4px 0 8px">No custom events yet — create one to turn a condition into a named, reusable trigger.</div>';
      return 0;
    }
    el.innerHTML = `<div class="list">${events.map(ev => `
      <div class="list-row">
        <span style="font-size:15px">🧬</span>
        <div class="list-main">
          <div class="list-title" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;white-space:normal">
            ${escHtml(ev.name)}
            <span class="badge badge-muted" style="font-size:10px">on ${escHtml(ev.underlyingEvent)}${ev.matcher ? ' · ' + escHtml(ev.matcher) : ''}</span>
            ${ev.wired && ev.fileExists
              ? '<span class="badge badge-success" style="font-size:10px">✓ active</span>'
              : `<span class="badge badge-warning" style="font-size:10px">⚠ ${!ev.fileExists ? 'script missing' : 'not wired'}</span>`}
          </div>
          <div class="list-sub">${escHtml(ev.description || '')}${ev.how ? ' — ' + escHtml(ev.how) : ''}</div>
        </div>
        <button class="icon-act" data-ce-edit="${escHtml(ev.filename)}" title="Edit detector script">✎</button>
        <button class="icon-act danger" data-ce-del="${escHtml(ev.name)}" title="Delete (removes script + unwires)">🗑</button>
      </div>`).join('')}</div>`;
    el.querySelectorAll('[data-ce-edit]').forEach(b => b.onclick = () => openFileEditor('hooks/' + b.dataset.ceEdit));
    el.querySelectorAll('[data-ce-del]').forEach(b => b.onclick = async () => {
      if (!await confirmDlg('Delete Custom Event', `Delete "${b.dataset.ceDel}"? This removes its script and unwires it from settings.json.`)) return;
      try { await api('DELETE', '/custom-events/' + encodeURIComponent(b.dataset.ceDel)); toast('Custom event removed'); loadHooks(); }
      catch (e) { toast(e.message, 'error'); }
    });
    return { count: events.length, unhealthy: events.some(ev => !ev.fileExists || !ev.wired) };
  } catch (e) {
    // Kidlin: an error must never look like an empty list
    el.innerHTML = `<div style="font-size:12px;color:var(--danger);padding:4px 0 8px">Couldn't load custom events (${escHtml(e.message)}) — <button class="link-btn" onclick="loadHooks()">retry</button></div>`;
    return 0;
  }
}

let _ceProvider = 'claude-cli';
let _ceDef = null;
let _ceLang = '.mjs';

function setCeLang(lang) {
  _ceLang = lang;
  document.querySelectorAll('#customEventModal [data-ce-lang]').forEach(b =>
    b.classList.toggle('active', b.dataset.ceLang === lang));
}
document.querySelectorAll('#customEventModal [data-ce-lang]').forEach(b => {
  b.onclick = () => setCeLang(b.dataset.ceLang);
});

async function setCeProvider(p) {
  _ceProvider = p;
  document.getElementById('ceProvCli').classList.toggle('active', p === 'claude-cli');
  document.getElementById('ceProvOr').classList.toggle('active', p === 'openrouter');
  document.getElementById('ceOrConfig').style.display = p === 'openrouter' ? '' : 'none';
  if (p === 'openrouter') {
    try {
      const cfg = await api('GET', '/ai-config');
      const status = document.getElementById('ceOrKeyStatus');
      const keyInput = document.getElementById('ceOrKey');
      if (cfg.hasOpenRouterKey) {
        status.textContent = '✓ key saved — leave blank to use it';
        status.style.color = 'var(--success)';
        keyInput.placeholder = '•••••••• (saved)';
      } else {
        status.textContent = '— required';
        status.style.color = 'var(--danger)';
        keyInput.placeholder = 'sk-or-…';
      }
      document.getElementById('ceOrModel').value = cfg.openRouterModel || 'anthropic/claude-sonnet-4-5';
    } catch {}
  }
}
document.getElementById('ceProvCli').onclick = () => setCeProvider('claude-cli');
document.getElementById('ceProvOr').onclick  = () => setCeProvider('openrouter');

document.getElementById('newCustomEventBtn').onclick = async () => {
  document.getElementById('ceWhen').value = '';
  document.getElementById('ceAction').value = '';
  document.getElementById('ceOrKey').value = '';
  document.getElementById('ceSetup').style.display = '';
  document.getElementById('ceReview').style.display = 'none';
  document.getElementById('ceDone').style.display = 'none';
  setCeLang('.mjs');
  document.getElementById('customEventModal').classList.add('open');
  try {
    const cfg = await api('GET', '/ai-config');
    setCeProvider(cfg.claudeCli ? 'claude-cli' : 'openrouter');
  } catch { setCeProvider('claude-cli'); }
  setTimeout(() => document.getElementById('ceWhen').focus(), 60);
};
document.getElementById('ceClose').onclick  = () => document.getElementById('customEventModal').classList.remove('open');
document.getElementById('ceCancel').onclick = () => document.getElementById('customEventModal').classList.remove('open');
document.getElementById('ceBack').onclick   = () => {
  document.getElementById('ceSetup').style.display = '';
  document.getElementById('ceReview').style.display = 'none';
};
document.querySelectorAll('#customEventModal [data-cewhen]').forEach(chip => {
  chip.onclick = () => {
    document.getElementById('ceWhen').value = chip.dataset.cewhen;
    document.getElementById('ceAction').value = chip.dataset.ceact || '';
  };
});

document.getElementById('ceGenerate').onclick = async () => {
  const when = document.getElementById('ceWhen').value.trim();
  if (!when) { toast('Describe when the event should fire', 'error'); return; }
  const btn = document.getElementById('ceGenerate');
  btn.disabled = true; btn.textContent = 'Designing…';
  try {
    // Save inline OpenRouter key/model first (same flow as everywhere else)
    if (_ceProvider === 'openrouter') {
      const inlineKey = document.getElementById('ceOrKey').value.trim();
      const model = document.getElementById('ceOrModel').value;
      await api('PUT', '/ai-config', inlineKey ? { openRouterKey: inlineKey, openRouterModel: model } : { openRouterModel: model });
    }
    _ceDef = await api('POST', '/ai/create-custom-event', {
      description: when,
      action: document.getElementById('ceAction').value.trim(),
      provider: _ceProvider,
      lang: _ceLang,
    });
    document.getElementById('ceName').value = _ceDef.name;
    document.getElementById('ceFilename').value = _ceDef.filename;
    document.getElementById('ceWiring').innerHTML =
      `Wires to <strong>${escHtml(_ceDef.underlyingEvent)}</strong>${_ceDef.matcher ? ` with matcher <code>${escHtml(_ceDef.matcher)}</code>` : ''} — ${escHtml(_ceDef.description || '')}`;
    document.getElementById('ceHow').textContent = _ceDef.how ? '⚙️ ' + _ceDef.how : '';
    document.getElementById('ceScript').value = _ceDef.hookScript;
    document.getElementById('ceSetup').style.display = 'none';
    document.getElementById('ceReview').style.display = '';
  } catch (e) {
    toast('Design failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '🧬 Design Event';
  }
};

document.getElementById('ceInstall').onclick = async () => {
  if (!_ceDef) return;
  const btn = document.getElementById('ceInstall');
  btn.disabled = true; btn.textContent = 'Installing…';
  const name = document.getElementById('ceName').value.trim();
  const filename = document.getElementById('ceFilename').value.trim();
  try {
    const r = await api('POST', '/custom-events/install', {
      ..._ceDef, name, filename,
      hookScript: document.getElementById('ceScript').value,
    });
    // DONE screen: proof of what happened + how to verify it — no guessing.
    const langLabel = { '.mjs': 'Node.js', '.js': 'Node.js', '.py': 'Python', '.sh': 'Bash', '.ps1': 'PowerShell' }[filename.match(/\.[^.]+$/)?.[0]] || 'script';
    document.getElementById('ceDoneSummary').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-weight:700;font-size:15px">✅ ${escHtml(name)} is live</div>
        <div class="card" style="padding:10px 14px;font-size:12.5px;line-height:1.6">
          <div>✓ <strong>Script created</strong> — <code>hooks/${escHtml(filename)}</code> (${langLabel}), executable, fail-open.</div>
          <div>✓ <strong>Wired automatically</strong> — registered under <code>${escHtml(_ceDef.underlyingEvent)}</code>${_ceDef.matcher ? ` with matcher <code>${escHtml(_ceDef.matcher)}</code>` : ''} in <code>settings.json</code>. This exact entry was written:</div>
          <pre style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:10.5px;overflow:auto;margin:6px 0">${escHtml(JSON.stringify(r.settingsSnippet, null, 2))}</pre>
          <div>✓ <strong>Registered</strong> — appears in Hooks → Custom Events with a live status badge.</div>
        </div>
        <div class="card" style="padding:10px 14px;font-size:12.5px;line-height:1.6">
          <div style="font-weight:650;margin-bottom:4px">How it works from now on</div>
          <div>${escHtml(_ceDef.how || '')}</div>
          <div style="margin-top:6px;color:var(--text-muted)">It fires automatically in <strong>every Claude Code session</strong> — nothing to invoke. To verify: check the ✓ active badge in the Custom Events panel, then trigger the condition in a Claude session (${escHtml(_ceDef.description || '')}).</div>
          <div style="margin-top:6px;color:var(--text-muted)">To change the detection or action: <strong>Edit script</strong> on its card. To retire it: <strong>Delete</strong> (removes the script and unwires it cleanly).</div>
        </div>
      </div>`;
    document.getElementById('ceReview').style.display = 'none';
    document.getElementById('ceDone').style.display = '';
    loadHooks();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '✓ Install & Wire Up';
  }
};
document.getElementById('ceDoneClose').onclick = () => document.getElementById('customEventModal').classList.remove('open');

// Hook/script files that live inside skills, plugins, agents, etc.
function renderElsewhereHooks(items) {
  const wrap = document.getElementById('hook-elsewhere-wrap');
  if (!wrap) return;
  if (!items.length) {
    wrap.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:8px 0">No scripts found inside skills or plugins.</div>';
    return;
  }
  wrap.innerHTML = `<div class="list">${items.map(f => `
      <div class="list-row">
        <span style="font-size:14px">📦</span>
        <div class="list-main">
          <div class="list-title mono" title="${escHtml(f.path)}">${escHtml(f.path)}</div>
          <div class="list-sub">${f.size} · ${fmtDate(f.modified)}</div>
        </div>
        <button class="icon-act accent" data-ew-explain="${escHtml(f.path)}" title="Explain with AI">🤖</button>
        <button class="icon-act" data-ew-edit="${escHtml(f.path)}" title="Edit">✎</button>
      </div>`).join('')}</div>`;
  wrap.querySelectorAll('[data-ew-edit]').forEach(b => b.onclick = () => openFileEditor(b.dataset.ewEdit));
  wrap.querySelectorAll('[data-ew-explain]').forEach(b => b.onclick = () => explainFile(b.dataset.ewExplain));
}

// ===== GENERIC FILE EDITOR / EXPLAINER (any file inside .claude) =====
const FILE_LANG = { md: 'markdown', mjs: 'javascript', js: 'javascript', ts: 'typescript', py: 'python', sh: 'shell', bash: 'shell', json: 'json', yaml: 'yaml', yml: 'yaml', html: 'html', css: 'css', txt: 'plaintext' };

async function openFileEditor(relPath) {
  try {
    const { content } = await api('GET', '/files?path=' + encodeURIComponent(relPath));
    const ext = (relPath.split('.').pop() || '').toLowerCase();
    openOverlay('Edit: ' + relPath, content, FILE_LANG[ext] || 'plaintext', null, async c => {
      await api('PUT', '/files', { path: relPath, content: c });
      toast('Saved: ' + relPath);
    });
  } catch (e) { toast(e.message, 'error'); }
}
window.openFileEditor = openFileEditor;

async function explainFile(relPath) {
  try {
    const { content } = await api('GET', '/files?path=' + encodeURIComponent(relPath));
    const ext = (relPath.split('.').pop() || '').toLowerCase();
    showExplainer(relPath, content, ext === 'md' ? 'markdown file' : ext + ' script', { scope: relPath });
  } catch (e) { toast(e.message, 'error'); }
}
window.explainFile = explainFile;

// ===== FILE EXPLORER (deep-dive into a skill or any folder) =====
async function openFileExplorer(relDir, title) {
  document.getElementById('feTitle').textContent = title || relDir;
  document.getElementById('fileExplorerModal').classList.add('open');
  const list = document.getElementById('feList');
  list.innerHTML = '<div style="padding:20px;color:var(--text-muted)">Loading…</div>';
  try {
    const entries = await api('GET', '/files/tree?dir=' + encodeURIComponent(relDir));
    if (!entries.length) { list.innerHTML = '<div style="padding:20px;color:var(--text-muted)">This folder is empty.</div>'; return; }
    const prefix = relDir.replace(/\/+$/, '') + '/';
    list.innerHTML = `<div class="list">${entries.map(e => {
      const display = e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path;
      return `
      <div class="list-row">
        <span style="font-size:14px">${display.endsWith('.md') ? '📄' : /\.(py|mjs|js|sh)$/.test(display) ? '⚙️' : '📎'}</span>
        <div class="list-main">
          <div class="list-title mono" title="${escHtml(e.path)}">${escHtml(display)}</div>
          <div class="list-sub">${e.size} · ${fmtDate(e.modified)}</div>
        </div>
        <button class="icon-act accent" data-fe-explain="${escHtml(e.path)}" title="Explain with AI">🤖</button>
        <button class="icon-act" data-fe-edit="${escHtml(e.path)}" title="Edit">✎</button>
      </div>`;
    }).join('')}</div>`;
    list.querySelectorAll('[data-fe-edit]').forEach(b => b.onclick = () => openFileEditor(b.dataset.feEdit));
    list.querySelectorAll('[data-fe-explain]').forEach(b => b.onclick = () => explainFile(b.dataset.feExplain));
  } catch (e) {
    list.innerHTML = `<div style="padding:20px;color:var(--danger)">${escHtml(e.message)}</div>`;
  }
}
window.openFileExplorer = openFileExplorer;

function renderHookEvents(hooksSettings) {
  const el = document.getElementById('hook-events-list');
  // Only show events that actually have hooks configured
  const configuredEvents = [...new Set([...ALL_HOOK_EVENTS, ...Object.keys(hooksSettings)])]
    .filter(evt => extractCmdsWithMatcher(hooksSettings[evt] || []).length > 0);

  if (!configuredEvents.length) {
    el.innerHTML = `<div style="padding:16px 0;text-align:center">
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:4px">No hooks configured yet.</div>
      <div style="color:var(--text-dim);font-size:12px">Click "+ Add Hook…" below to register your first hook.</div>
    </div>`;
    return;
  }

  el.innerHTML = configuredEvents.map(evt => {
    const cmds = extractCmdsWithMatcher(hooksSettings[evt] || []);
    return `
      <div class="hook-event" style="margin-bottom:8px">
        <div class="hook-event-header" data-evt="${escHtml(evt)}">
          <span class="hook-event-name">${escHtml(evt)}</span>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="hook-event-count">${cmds.length} hook(s)</span>
            <button class="btn btn-secondary btn-sm hk-add" data-evt="${escHtml(evt)}">+ Add</button>
          </div>
        </div>
        <div class="hook-event-body open">
          ${cmds.map(({ matcher, cmd }, i) => `
            <div class="hook-command-row">
              <span class="${matcher ? 'hook-matcher-badge' : 'hook-any-badge'}">${escHtml(matcher || 'any')}</span>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px" title="${escHtml(cmd)}">${escHtml(cmd)}</span>
              <button class="btn-explain hk-explain" data-evt="${escHtml(evt)}" data-cmd="${escHtml(cmd)}" title="Explain with AI" style="font-size:12px;padding:2px 6px">🤖</button>
              <button class="btn btn-secondary btn-sm hk-edit" data-evt="${escHtml(evt)}" data-i="${i}" data-matcher="${escHtml(matcher)}" data-cmd="${escHtml(cmd)}" title="Edit">✎</button>
              <button class="btn btn-danger btn-sm hk-del" data-evt="${escHtml(evt)}" data-i="${i}">×</button>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.hook-event-header').forEach(h => {
    h.onclick = e => { if (!e.target.classList.contains('hk-add')) h.nextElementSibling.classList.toggle('open'); };
  });
  el.querySelectorAll('.hk-add').forEach(b => { b.onclick = e => { e.stopPropagation(); showHookAddModal(b.dataset.evt); }; });
  el.querySelectorAll('.hk-edit').forEach(b => { b.onclick = () => showHookAddModal(b.dataset.evt, b.dataset.cmd, '', +b.dataset.i, b.dataset.matcher); });
  el.querySelectorAll('.hk-del').forEach(b => { b.onclick = () => deleteHookCommand(b.dataset.evt, +b.dataset.i); });
  el.querySelectorAll('.hk-explain').forEach(b => { b.onclick = e => { e.stopPropagation(); showExplainer(b.dataset.cmd, b.dataset.cmd, 'hook', { scope: b.dataset.evt }); }; });
}

// ===== HOOK ADD/EDIT MODAL =====
function showHookAddModal(evt, prefillCommand = '', subtitleOverride = '', editIdx = -1, prefillMatcher = '') {
  // evt=null means "global add" — user picks event in the modal
  const isGlobal = !evt;
  const isEdit = editIdx >= 0;

  document.getElementById('hookAddTitle').textContent = isEdit ? `Edit Hook — ${evt}` : (isGlobal ? 'Add Hook' : `Add Hook — ${evt}`);
  document.getElementById('hookAddSubtitle').textContent = subtitleOverride || (isGlobal
    ? 'Choose a lifecycle event, then configure the command to run.'
    : (MATCHER_EVENTS.has(evt)
        ? 'Set a Matcher to run only after a specific tool, or leave "Any tool" to always run.'
        : 'This event fires globally — the Matcher field does not apply to this event type.'));

  document.getElementById('hookAddConfirm').textContent = isEdit ? 'Save Changes' : 'Add Hook';
  document.getElementById('hookEventGroup').style.display   = isGlobal ? 'block' : 'none';
  document.getElementById('hookMatcherGroup').style.display = (!isGlobal && MATCHER_EVENTS.has(evt)) ? 'block' : 'none';
  document.getElementById('hookEventSelect').value  = '';
  document.getElementById('hookMatcherInput').value = prefillMatcher;
  document.getElementById('hookCommandInput').value = prefillCommand;

  // When event changes in global mode, update matcher visibility and label
  document.getElementById('hookEventSelect').onchange = () => {
    const sel = document.getElementById('hookEventSelect').value;
    const isTool = sel && MATCHER_EVENTS.has(sel);
    const isFile = sel === 'FileChanged';
    document.getElementById('hookMatcherGroup').style.display = (isTool || isFile || sel === 'SessionStart' || sel === 'SessionEnd') ? 'block' : 'none';
    const label = document.querySelector('#hookMatcherGroup .form-label');
    if (label) {
      label.innerHTML = isTool
        ? 'Tool matcher (regex) <span style="color:var(--text-dim);font-weight:400;text-transform:none;font-size:11px">— optional</span>'
        : isFile
          ? 'Watch files (pipe-separated) <span style="color:var(--text-dim);font-weight:400;text-transform:none;font-size:11px">— e.g. .env|.envrc</span>'
          : 'Matcher <span style="color:var(--text-dim);font-weight:400;text-transform:none;font-size:11px">— optional</span>';
    }
    document.getElementById('hookMatcherInput').placeholder = isTool
      ? 'e.g.  Edit   or   Edit|Write|Bash   or   mcp__.*'
      : isFile ? '.env|.envrc' : '';
  };

  // Populate existing hook file suggestions with full paths
  api('GET', '/hooks').then(data => {
    const sugg = document.getElementById('hookFileSuggestions');
    if (!data.files.length) { sugg.innerHTML = ''; return; }
    const folder = document.getElementById('folderPath').textContent;
    sugg.innerHTML = `<div class="hook-suggestions-label">Existing hook files (click to use):</div>
      <div class="hook-suggestions">${data.files.map(f =>
        `<div class="hook-suggestion" data-path="${escHtml(folder + '/hooks/' + f.name)}">📄 ${escHtml(f.name)}</div>`
      ).join('')}</div>`;
    sugg.querySelectorAll('.hook-suggestion').forEach(el => {
      el.onclick = () => { document.getElementById('hookCommandInput').value = el.dataset.path; };
    });
  }).catch(() => {});

  // Reset AI gen panel
  _hookGenContent = ''; _hookGenFilename = ''; _hookGenLang = 'mjs';
  document.getElementById('hookGenPanel').style.display = 'none';
  document.getElementById('hookGenToggle').textContent = '✨ Generate with AI';
  document.getElementById('hookGenDesc').value = '';
  document.getElementById('hookGenPreview').style.display = 'none';
  document.getElementById('hookGenError').style.display = 'none';
  document.querySelectorAll('[data-hg-lang]').forEach(b => b.classList.toggle('active', b.dataset.hgLang === 'mjs'));

  document.getElementById('hookAddModal').classList.add('open');
  setTimeout(() => document.getElementById(isGlobal ? 'hookEventSelect' : 'hookCommandInput').focus(), 80);

  hookAddCallback = async () => {
    const activeEvt = evt || document.getElementById('hookEventSelect').value;
    if (!activeEvt) { toast('Select an event first', 'error'); document.getElementById('hookEventSelect').focus(); return; }
    const matcher = MATCHER_EVENTS.has(activeEvt) ? document.getElementById('hookMatcherInput').value.trim() : '';
    const command = document.getElementById('hookCommandInput').value.trim();
    if (!command) { toast('Command path is required', 'error'); document.getElementById('hookCommandInput').focus(); return; }
    const settings = await api('GET', '/settings');
    if (!settings.hooks) settings.hooks = {};

    if (isEdit) {
      // Flatten → replace at index → regroup
      const flat = (settings.hooks[activeEvt] || []).flatMap(g =>
        (g.hooks || []).map(h => ({ type: h.type || 'command', command: h.command || '', matcher: g.matcher || '' })));
      flat[editIdx] = { type: 'command', command, matcher };
      const byMatcher = {};
      flat.forEach(h => { const m = h.matcher; if (!byMatcher[m]) byMatcher[m] = []; byMatcher[m].push({ type: h.type, command: h.command }); });
      settings.hooks[activeEvt] = Object.entries(byMatcher).map(([m, hooks]) => m ? { matcher: m, hooks } : { hooks });
      toast(`Hook updated in ${activeEvt}`);
    } else {
      if (!settings.hooks[activeEvt]) settings.hooks[activeEvt] = [];
      const group = { hooks: [{ type: 'command', command }] };
      if (matcher) group.matcher = matcher;
      settings.hooks[activeEvt].push(group);
      toast(`Hook added to ${activeEvt}${matcher ? ' (matcher: ' + matcher + ')' : ''}`);
    }

    await api('PUT', '/settings', { settings });
    document.getElementById('hookAddModal').classList.remove('open');
    document.getElementById('hookAddConfirm').textContent = 'Add Hook';
    loadHooks();
  };
}

function toggleHookGenPanel() {
  const panel = document.getElementById('hookGenPanel');
  const open = panel.style.display === 'none';
  panel.style.display = open ? '' : 'none';
  document.getElementById('hookGenToggle').textContent = open ? '✕ Close generator' : '✨ Generate with AI';
  if (open) {
    setTimeout(() => document.getElementById('hookGenDesc').focus(), 60);
    // Auto-select the best available provider (no CLI → OpenRouter, config shown)
    api('GET', '/ai-config')
      .then(cfg => setHookGenProvider(cfg.claudeCli ? 'claude-cli' : 'openrouter'))
      .catch(() => setHookGenProvider('claude-cli'));
  }
}

function setHookGenLang(ext, btn) {
  _hookGenLang = ext;
  document.querySelectorAll('[data-hg-lang]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

let _hookGenProvider = 'claude-cli';
async function setHookGenProvider(p) {
  _hookGenProvider = p;
  document.getElementById('hgProvCli').classList.toggle('active', p === 'claude-cli');
  document.getElementById('hgProvOr').classList.toggle('active', p === 'openrouter');
  document.getElementById('hgOrConfig').style.display = p === 'openrouter' ? '' : 'none';
  if (p === 'openrouter') {
    try {
      const cfg = await api('GET', '/ai-config');
      const status = document.getElementById('hgOrKeyStatus');
      const keyInput = document.getElementById('hgOrKey');
      if (cfg.hasOpenRouterKey) {
        status.textContent = '✓ key saved — leave blank to use it';
        status.style.color = 'var(--success)';
        keyInput.placeholder = '•••••••• (saved)';
      } else {
        status.textContent = '— required';
        status.style.color = 'var(--danger)';
        keyInput.placeholder = 'sk-or-…';
      }
      document.getElementById('hgOrModel').value = cfg.openRouterModel || 'anthropic/claude-sonnet-4-5';
    } catch {}
  }
}
document.getElementById('hgProvCli').onclick = () => setHookGenProvider('claude-cli');
document.getElementById('hgProvOr').onclick  = () => setHookGenProvider('openrouter');

async function runHookGenInModal() {
  const desc = document.getElementById('hookGenDesc').value.trim();
  if (!desc) { toast('Describe what the hook should do first', 'error'); return; }
  const btn = document.getElementById('hookGenRunBtn');
  const orig = btn.textContent;
  btn.textContent = '⏳ Generating…'; btn.disabled = true;
  document.getElementById('hookGenPreview').style.display = 'none';
  document.getElementById('hookGenError').style.display = 'none';
  try {
    if (_hookGenProvider === 'openrouter') {
      const inlineKey = document.getElementById('hgOrKey').value.trim();
      const model = document.getElementById('hgOrModel').value;
      await api('PUT', '/ai-config', inlineKey ? { openRouterKey: inlineKey, openRouterModel: model } : { openRouterModel: model });
    }
    const res = await api('POST', '/ai/generate-skill', {
      type: 'hook',
      prompt: desc,                       // the endpoint's required field
      provider: _hookGenProvider,
      hookLang: '.' + _hookGenLang,       // server expects '.mjs' / '.py' / '.sh'
    });
    _hookGenContent = res.content || '';
    const ts = Date.now();
    _hookGenFilename = `generated-hook-${ts}.${_hookGenLang}`;
    document.getElementById('hookGenCode').textContent = _hookGenContent;
    document.getElementById('hookGenFilename').textContent = `Will save as: hooks/${_hookGenFilename}`;
    document.getElementById('hookGenPreview').style.display = '';
  } catch (e) {
    document.getElementById('hookGenError').textContent = e.message || 'Generation failed';
    document.getElementById('hookGenError').style.display = '';
  } finally {
    btn.textContent = orig; btn.disabled = false;
  }
}

async function useGeneratedHook() {
  if (!_hookGenContent) return;
  const btn = document.getElementById('hookGenUseBtn');
  btn.textContent = '⏳ Saving…'; btn.disabled = true;
  try {
    await api('POST', '/hooks/files', { name: _hookGenFilename, content: _hookGenContent });
    const folder = document.getElementById('folderPath').textContent.trim();
    const INTERP = { mjs: '', py: 'python3 ', sh: 'bash ' };
    document.getElementById('hookCommandInput').value = (INTERP[_hookGenLang] || '') + folder + '/hooks/' + _hookGenFilename;
    document.getElementById('hookGenPanel').style.display = 'none';
    document.getElementById('hookGenToggle').textContent = '✨ Generate with AI';
    toast(`Saved ${_hookGenFilename} — fill in the event above and click Add Hook`);
    // refresh file suggestions
    api('GET', '/hooks').then(data => {
      const sugg = document.getElementById('hookFileSuggestions');
      if (!data.files.length) return;
      sugg.innerHTML = `<div class="hook-suggestions-label">Existing hook files (click to use):</div>
        <div class="hook-suggestions">${data.files.map(f =>
          `<div class="hook-suggestion" data-path="${escHtml(folder + '/hooks/' + f.name)}">📄 ${escHtml(f.name)}</div>`
        ).join('')}</div>`;
      sugg.querySelectorAll('.hook-suggestion').forEach(el => {
        el.onclick = () => { document.getElementById('hookCommandInput').value = el.dataset.path; };
      });
    }).catch(() => {});
  } catch (e) {
    toast(e.message || 'Failed to save file', 'error');
  } finally {
    btn.textContent = '✓ Save file & use as command'; btn.disabled = false;
  }
}

document.getElementById('hookAddCancel').onclick  = () => { document.getElementById('hookAddModal').classList.remove('open'); document.getElementById('hookAddConfirm').textContent = 'Add Hook'; };
document.getElementById('hookAddConfirm').onclick = async () => { if (hookAddCallback) try { await hookAddCallback(); } catch (e) { toast(e.message, 'error'); } };
document.getElementById('hookCommandInput').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('hookAddConfirm').click(); });
document.getElementById('addHookEventBtn').onclick = () => showHookAddModal(null);

// Matcher chip buttons — click to append/set value
document.getElementById('hookAddModal').addEventListener('click', e => {
  if (!e.target.classList.contains('matcher-chip')) return;
  const input = document.getElementById('hookMatcherInput');
  const chip = e.target.dataset.val;
  const cur = input.value.trim();
  input.value = cur ? cur + '|' + chip : chip;
  input.focus();
});

async function deleteHookCommand(evt, idx) {
  const ok = await confirmDlg('Delete Hook', `Remove hook from ${evt}?`);
  if (!ok) return;
  const settings = await api('GET', '/settings');
  // Flatten preserving matcher, splice, then regroup
  const flat = (settings.hooks?.[evt] || []).flatMap(g => (g.hooks || []).map(h => ({ ...h, matcher: g.matcher || '' })));
  flat.splice(idx, 1);
  if (!flat.length) { delete settings.hooks[evt]; }
  else {
    const byMatcher = {};
    flat.forEach(h => { const m = h.matcher; if (!byMatcher[m]) byMatcher[m] = []; byMatcher[m].push({ type: h.type, command: h.command }); });
    settings.hooks[evt] = Object.entries(byMatcher).map(([m, hooks]) => m ? { matcher: m, hooks } : { hooks });
  }
  await api('PUT', '/settings', { settings });
  toast('Hook removed');
  loadHooks();
}

function renderHookFiles(files, wiredMap = {}) {
  const el = document.getElementById('hook-files-list');
  if (!files.length) { el.innerHTML = '<div class="text-muted" style="font-size:13px">No hook files yet. Click "+ New Hook File" to create one.</div>'; return; }
  el.innerHTML = `<div class="list">${files.map(f => {
    const events = [...(wiredMap[f.name] || [])];
    const wired = events.length > 0;
    return `
    <div class="list-row">
      <span style="font-size:14px">📄</span>
      <div class="list-main">
        <div class="list-title mono">${escHtml(f.name)}
          ${wired
            ? `<span class="badge badge-success" style="font-size:10px;margin-left:6px" title="Fires automatically on: ${escHtml(events.join(', '))}">● ${escHtml(events.slice(0, 2).join(', '))}${events.length > 2 ? ' +' + (events.length - 2) : ''}</span>`
            : '<span class="badge badge-warning" style="font-size:10px;margin-left:6px" title="This file never runs until it is wired to a lifecycle event">○ not wired</span>'}
        </div>
        <div class="list-sub">${f.size} · ${fmtDate(f.modified)}</div>
      </div>
      ${!wired ? `<button class="icon-act accent" data-hf-wire="${escHtml(f.name)}" title="Wire to a lifecycle event — required before it can run">⚡</button>` : ''}
      <button class="icon-act accent" data-hf-explain="${escHtml(f.name)}" title="Explain with AI">🤖</button>
      <button class="icon-act" data-hf-edit="${escHtml(f.name)}" title="Edit">✎</button>
      <button class="icon-act danger" data-hf-del="${escHtml(f.name)}" title="Delete">🗑</button>
    </div>`;
  }).join('')}</div>`;
  el.querySelectorAll('[data-hf-wire]').forEach(b => {
    b.onclick = () => {
      const folder = document.getElementById('folderPath').textContent.trim();
      showHookAddModal(null, folder + '/hooks/' + b.dataset.hfWire, `Pick the lifecycle event that should trigger ${b.dataset.hfWire}`);
    };
  });
  el.querySelectorAll('[data-hf-explain]').forEach(b => {
    b.onclick = () => {
      const file = files.find(f => f.name === b.dataset.hfExplain);
      if (file) showExplainer(file.name, file.content || '', 'hook', { ext: file.name.split('.').pop() });
    };
  });
  el.querySelectorAll('[data-hf-edit]').forEach(b => { b.onclick = () => editHookFile(b.dataset.hfEdit); });
  el.querySelectorAll('[data-hf-del]').forEach(b  => { b.onclick = () => deleteHookFile(b.dataset.hfDel); });
}

document.getElementById('newHookFileBtn').onclick = () => {
  showTemplateGallery('hook-file', (name, content) => {
    if (!/\.(mjs|js|sh|py|ps1|cmd|bat)$/.test(name)) name += currentHookExt;
    const ext  = name.match(/\.[^.]+$/)?.[0] || '.mjs';
    const lang = HOOK_RUNTIME_META[ext]?.lang || 'javascript';
    openOverlay('New Hook: ' + name, content, lang, 'hook-file', async c => {
      await api('POST', '/hooks/files', { name, content: c });
      loadHooks();
      const folder = document.getElementById('folderPath').textContent;
      const fullPath = folder + '/hooks/' + name;
      toast('Hook file created — register it to a lifecycle event');
      setTimeout(() => showHookAddModal(null, fullPath, '✓ File created — now pick a lifecycle event to register it.'), 350);
    }, true);
  });
};

async function editHookFile(name) {
  const data = await api('GET', '/hooks');
  const file = data.files.find(f => f.name === name);
  const ext  = name.match(/\.[^.]+$/)?.[0] || '.mjs';
  const lang = HOOK_RUNTIME_META[ext]?.lang || 'javascript';
  openOverlay('Edit: ' + name, file?.content || '', lang, 'hook-file', async c => {
    await api('PUT', '/hooks/files/' + encodeURIComponent(name), { content: c });
    toast('Hook file saved'); loadHooks();
  });
}

async function deleteHookFile(name) {
  const ok = await confirmDlg('Delete Hook File', `Delete hooks/${name}?`);
  if (!ok) return;
  await api('DELETE', '/hooks/files/' + encodeURIComponent(name));
  toast('Deleted: ' + name); loadHooks();
}

// ===== TEMPLATE GALLERY =====
const GALLERY_META = {
  skill:      { title: 'New Skill',      subtitle: 'Skills extend Claude\'s capabilities and appear in system reminders.',           placeholder: 'my-skill' },
  agent:      { title: 'New Agent',      subtitle: 'Agents are specialised Claude instances with custom tools, model, or system prompt.', placeholder: 'my-agent' },
  command:    { title: 'New Command',    subtitle: 'Commands create /slash-commands the user can invoke in chat.',                   placeholder: 'my-command' },
  'hook-file':{ title: 'New Hook File',  subtitle: 'Hook scripts run at Claude Code lifecycle events (SessionStart, PostToolUse…).',  placeholder: 'my-hook.mjs' },
};

function showTemplateGallery(type, onSelect) {
  currentGalleryType = type;
  const meta = GALLERY_META[type] || {};
  const tmpls = TEMPLATES[type] || [];

  document.getElementById('templateModalTitle').textContent    = meta.title || 'New';
  document.getElementById('templateModalSubtitle').textContent = meta.subtitle || '';
  document.getElementById('templateNameInput').placeholder     = meta.placeholder || 'my-name';
  document.getElementById('templateNameInput').value           = '';

  selectedTemplate = tmpls[0] || null;
  renderTemplateCards(tmpls);

  // Show runtime picker only for hook files
  const picker = document.getElementById('hookRuntimePicker');
  picker.style.display = type === 'hook-file' ? '' : 'none';
  if (type === 'hook-file') {
    currentHookExt = '.mjs'; currentHookLang = 'javascript';
    document.querySelectorAll('.hook-runtime-btn').forEach(b => b.classList.toggle('active', b.dataset.ext === '.mjs'));
    document.getElementById('hookRuntimeWarning').style.display = 'none';
  }

  document.getElementById('templateModal').classList.add('open');
  setTimeout(() => document.getElementById('templateNameInput').focus(), 80);

  document.getElementById('templateModalOpen').onclick = () => {
    const raw = document.getElementById('templateNameInput').value.trim();
    if (!raw) { toast('Enter a name first', 'error'); document.getElementById('templateNameInput').focus(); return; }
    // For non-mjs hook runtimes, use runtime-appropriate starter instead of template content
    let content = selectedTemplate ? selectedTemplate.content(raw) : '';
    if (currentGalleryType === 'hook-file' && currentHookExt !== '.mjs' && currentHookExt !== '.js') {
      content = (HOOK_RUNTIME_STARTERS[currentHookExt] || HOOK_RUNTIME_STARTERS['.mjs'])(raw);
    }
    document.getElementById('templateModal').classList.remove('open');
    onSelect(raw, content);
  };
}

function renderTemplateCards(tmpls) {
  const list = document.getElementById('templateCardList');
  list.innerHTML = tmpls.map((t, i) => `
    <div class="template-card ${i === 0 ? 'selected' : ''}" data-idx="${i}">
      <div class="template-card-name">${t.icon} ${escHtml(t.name)}</div>
      <div class="template-card-desc">${escHtml(t.desc)}</div>
    </div>`).join('');
  list.querySelectorAll('.template-card').forEach((card, i) => {
    card.onclick = () => {
      list.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedTemplate = tmpls[i];
      refreshTemplatePreview();
    };
  });
  refreshTemplatePreview();
}

function refreshTemplatePreview() {
  if (!selectedTemplate) return;
  const name    = document.getElementById('templateNameInput').value || document.getElementById('templateNameInput').placeholder;
  const content = selectedTemplate.content(name || 'example');
  const ref     = FIELD_REF[currentGalleryType];

  // Syntax-colour the template — only code, no ref section mixed in
  document.getElementById('templatePreviewContent').innerHTML = content.split('\n').map(line => {
    const e = escHtml(line);
    if (line === '---')                                   return `<span class="tpl-divider">${e}</span>`;
    if (/^#{1,3} /.test(line))                           return `<span class="tpl-heading">${e}</span>`;
    if (line.startsWith('//'))                            return `<span class="tpl-comment">${e}</span>`;
    if (line.match(/^[a-zA-Z_]+:/)) {
      const c = line.indexOf(':');
      return `<span class="tpl-key">${escHtml(line.slice(0, c + 1))}</span><span class="tpl-value">${escHtml(line.slice(c + 1))}</span>`;
    }
    if (line.match(/^\s+-\s/))                           return `<span class="tpl-value">${e}</span>`;
    return e;
  }).join('\n');

  // Render field reference as readable HTML table below the code
  const refEl = document.getElementById('templateFieldRef');
  if (!ref) { refEl.innerHTML = ''; return; }
  refEl.innerHTML = `
    <div class="fref-header">Field Reference</div>
    ${ref.fields.map(f => `
      <div class="fref-row">
        <div class="fref-left">
          <code class="fref-name">${escHtml(f.name)}</code>
          <span class="badge ${f.req === true ? 'badge-accent' : f.req === 'rec' ? 'badge-warning' : 'badge-muted'}" style="font-size:9px">${f.req === true ? 'required' : f.req === 'rec' ? 'recommended' : 'optional'}</span>
          <span class="fref-type">${escHtml(f.type)}</span>
        </div>
        <div class="fref-right">
          <div class="fref-desc">${escHtml(f.desc)}</div>
          <div class="fref-ex">e.g. <code>${escHtml(f.ex)}</code></div>
        </div>
      </div>`).join('')}
    ${ref.note ? `<div class="fref-note">${escHtml(ref.note)}</div>` : ''}`;
}

document.getElementById('templateNameInput').addEventListener('input', () => {
  const val = document.getElementById('templateNameInput').value;
  const isHookFile = currentGalleryType === 'hook-file';
  const valid = val === '' || (isHookFile ? /^[a-zA-Z0-9_.-]+$/ : /^[a-zA-Z0-9_-]+$/).test(val);
  document.getElementById('templateNameInput').classList.toggle('input-error', val !== '' && !valid);
  const hint = document.querySelector('#templateModal .form-group div');
  if (hint) hint.textContent = !valid ? 'Invalid characters — use letters, numbers, hyphens, underscores only.' : (isHookFile ? `Extension (${currentHookExt}) added automatically if omitted.` : 'Alphanumeric, hyphens, underscores only.');
  refreshTemplatePreview();
});
document.getElementById('hookRuntimePicker').addEventListener('click', e => {
  const btn = e.target.closest('.hook-runtime-btn');
  if (btn) setHookRuntime(btn.dataset.ext);
});
document.getElementById('templateModalCancel').onclick = () => document.getElementById('templateModal').classList.remove('open');
document.getElementById('templateModalClose').onclick  = () => document.getElementById('templateModal').classList.remove('open');
document.getElementById('templateModal').addEventListener('click', e => { if (e.target === document.getElementById('templateModal')) document.getElementById('templateModal').classList.remove('open'); });
document.getElementById('templateNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('templateModalOpen').click(); });

// ===== SKILLS =====
async function loadSkills() {
  const items = await api('GET', '/skills');
  renderItemGrid('skills-grid', items, 'skill', '🧩', editSkill, deleteSkill);
  document.getElementById('badge-skills').textContent = items.length;
}

// ===== SKILL STORE =====
let _skillStoreData = [];
let _skillStoreSources = [];

(function () {
  document.querySelectorAll('.skill-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.skill-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const isStore = tab.dataset.skillTab === 'store';
      document.getElementById('skills-installed-panel').style.display = isStore ? 'none' : '';
      document.getElementById('skills-store-panel').style.display    = isStore ? '' : 'none';
      document.getElementById('skillsInstalledActions').style.display = isStore ? 'none' : '';
      if (isStore) { loadSkillStoreSources(); if (!_skillStoreData.length) loadSkillStore(); }
    };
  });
  document.getElementById('skillStoreSearch')?.addEventListener('input', () => renderSkillStoreGrid(_skillStoreData));
  document.getElementById('skillStoreSourceFilter')?.addEventListener('change', () => renderSkillStoreGrid(_skillStoreData));
  document.getElementById('skillStoreRefresh')?.addEventListener('click', () => { _skillStoreData = []; delete _mktCache; loadSkillStore(); });
  document.getElementById('skillStoreManageSources')?.addEventListener('click', () => {
    const panel = document.getElementById('skillSourcesPanel');
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
    if (panel.style.display !== 'none') loadSkillStoreSources();
  });
  document.getElementById('addSkillSourceBtn')?.addEventListener('click', async () => {
    const name   = document.getElementById('addSrcName').value.trim();
    const repo   = document.getElementById('addSrcRepo').value.trim();
    const path   = document.getElementById('addSrcPath').value.trim() || 'skills';
    const branch = document.getElementById('addSrcBranch').value.trim() || 'main';
    if (!name || !repo) { toast('Name and repo are required', 'error'); return; }
    try {
      await api('POST', '/skill-store/sources', { name, repo, path, branch });
      document.getElementById('addSrcName').value = '';
      document.getElementById('addSrcRepo').value = '';
      document.getElementById('addSrcPath').value = '';
      document.getElementById('addSrcBranch').value = '';
      toast('Source added — refreshing store…');
      _skillStoreData = [];
      await loadSkillStoreSources();
      loadSkillStore();
    } catch (e) { toast(e.message, 'error'); }
  });
})();

async function loadSkillStoreSources() {
  _skillStoreSources = await api('GET', '/skill-store/sources').catch(() => []);
  // Populate filter dropdown
  const filter = document.getElementById('skillStoreSourceFilter');
  if (filter) {
    filter.innerHTML = '<option value="all">All sources</option>'
      + _skillStoreSources.map(s => `<option value="${escHtml(s.id)}">${escHtml((s.icon || '') + ' ' + s.name)}</option>`).join('');
  }
  // Render sources list in management panel
  renderSkillSourcesList();
}

function renderSkillSourcesList() {
  const list = document.getElementById('skillSourcesList');
  if (!list) return;
  if (!_skillStoreSources.length) { list.innerHTML = '<div style="color:var(--text-dim);font-size:12px">No sources configured.</div>'; return; }
  list.innerHTML = _skillStoreSources.map(s => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:16px">${s.icon || '📦'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600">${escHtml(s.name)}</div>
        <div style="font-size:11px;color:var(--text-dim)">${escHtml(s.repo)}/${escHtml(s.path || 'skills')} @ ${escHtml(s.branch || 'main')}</div>
      </div>
      ${s.builtin
        ? '<span class="badge badge-accent" style="font-size:10px">Built-in</span>'
        : `<label class="toggle-switch" title="Enable/disable source">
             <input type="checkbox" ${s.enabled !== false ? 'checked' : ''} data-src-toggle="${escHtml(s.id)}">
             <span class="toggle-slider"></span>
           </label>
           <button class="btn btn-danger btn-sm" data-src-del="${escHtml(s.id)}" title="Remove source">✕</button>`
      }
    </div>`).join('');
  list.querySelectorAll('[data-src-toggle]').forEach(cb => {
    cb.onchange = async () => {
      try { await api('PUT', `/skill-store/sources/${cb.dataset.srcToggle}/toggle`); _skillStoreData = []; loadSkillStore(); }
      catch (e) { toast(e.message, 'error'); cb.checked = !cb.checked; }
    };
  });
  list.querySelectorAll('[data-src-del]').forEach(btn => {
    btn.onclick = async () => {
      if (!await confirmDlg('Remove Source', 'Remove this skill source? Skills already installed from it stay in place.')) return;
      try { await api('DELETE', `/skill-store/sources/${btn.dataset.srcDel}`); _skillStoreData = []; loadSkillStoreSources(); loadSkillStore(); }
      catch (e) { toast(e.message, 'error'); }
    };
  });
}

async function loadSkillStore() {
  const grid = document.getElementById('skills-store-grid');
  grid.innerHTML = `<div style="grid-column:1/-1;padding:48px;text-align:center;color:var(--text-muted)">
    <div class="spinner" style="width:28px;height:28px;border-width:3px;margin:0 auto 14px"></div>
    <div>Loading skills from all sources…</div>
    <div style="font-size:11px;margin-top:4px">~5 seconds on first load, cached for 5 minutes</div>
  </div>`;
  try {
    _skillStoreData = await api('GET', '/skill-store/browse');
    renderSkillStoreGrid(_skillStoreData);
  } catch (e) {
    grid.innerHTML = `<div style="grid-column:1/-1;padding:32px;text-align:center;color:var(--danger)">
      Failed to load Skill Store: ${escHtml(e.message)}<br>
      <span style="font-size:12px;color:var(--text-muted)">Check your internet connection or GitHub API rate limit</span>
    </div>`;
  }
}

function renderSkillStoreGrid(skills) {
  const search    = (document.getElementById('skillStoreSearch')?.value || '').toLowerCase();
  const srcFilter = document.getElementById('skillStoreSourceFilter')?.value || 'all';
  let filtered = skills;
  if (search) filtered = filtered.filter(s =>
    s.name.toLowerCase().includes(search) ||
    (s.displayName || '').toLowerCase().includes(search) ||
    (s.description || '').toLowerCase().includes(search)
  );
  if (srcFilter !== 'all') filtered = filtered.filter(s => s.sourceId === srcFilter);

  const grid = document.getElementById('skills-store-grid');
  if (!filtered.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:32px">No skills found</div>';
    return;
  }
  grid.innerHTML = filtered.map(s => `
    <div class="skill-card" id="sstore-${escHtml(s.id)}">
      <div class="skill-card-name">🧩 ${escHtml(s.displayName || s.name)}</div>
      <div class="skill-card-desc" style="flex:1">${escHtml((s.description || '').slice(0, 130))}${(s.description||'').length > 130 ? '…' : ''}</div>
      <div style="font-size:10px;color:var(--text-dim);margin-top:6px">${escHtml(s.sourceLabel || '')}</div>
      <div class="skill-card-actions" style="margin-top:8px">
        <button class="btn-explain" onclick="showExplainer('${escHtml(s.displayName||s.name)}','Name: ${escHtml(s.displayName||s.name)}\\nDescription: ${escHtml(s.description||'No description')}','skill',{sourceLabel:'${escHtml(s.sourceLabel||'')}'})" title="Explain with AI">🤖 Explain</button>
        ${s.installed
          ? `<span class="badge badge-success" style="font-size:11px">✓ Installed</span>
             <button class="btn btn-secondary btn-sm" data-store-id="${escHtml(s.id)}" data-store-name="${escHtml(s.name)}" data-source-id="${escHtml(s.sourceId||'official')}">↓ Reinstall</button>`
          : `<button class="btn btn-primary btn-sm" data-store-id="${escHtml(s.id)}" data-store-name="${escHtml(s.name)}" data-source-id="${escHtml(s.sourceId||'official')}">↓ Install</button>`}
      </div>
    </div>`).join('');

  grid.querySelectorAll('[data-store-id]').forEach(btn => {
    btn.onclick = async () => {
      const skillName = btn.dataset.storeName;
      const sourceId  = btn.dataset.sourceId;
      const orig = btn.textContent;
      btn.textContent = '⏳ Downloading…'; btn.disabled = true;
      try {
        const result = await api('POST', '/skill-store/install', { skillName, sourceId });
        const skill = skills.find(s => s.id === btn.dataset.storeId);
        toast(`${skill?.displayName || skillName} installed (${result.installed} files)!`);
        if (skill) skill.installed = true;
        const card = document.getElementById('sstore-' + btn.dataset.storeId);
        if (card) {
          const actions = card.querySelector('.skill-card-actions');
          actions.innerHTML = `<span class="badge badge-success" style="font-size:11px">✓ Installed</span>
            <button class="btn btn-secondary btn-sm" data-store-id="${escHtml(btn.dataset.storeId)}" data-store-name="${escHtml(skillName)}" data-source-id="${escHtml(sourceId)}">↓ Reinstall</button>`;
          actions.querySelector('[data-store-id]').onclick = btn.onclick;
        }
        loadSkills();
      } catch (e) { toast(e.message, 'error'); btn.textContent = orig; btn.disabled = false; }
    };
  });
}

document.getElementById('skillGenBtn').onclick = () => showSkillGenerator();

document.getElementById('newSkillBtn').onclick = () => {
  showTemplateGallery('skill', (name, content) => {
    openOverlay('New Skill: ' + name, content, 'markdown', 'skill', async c => {
      await api('POST', '/skills', { name, content: c }); toast('Skill created: ' + name); loadSkills();
    }, true);
  });
};
async function editSkill(name) {
  const { content } = await api('GET', '/skills/' + encodeURIComponent(name));
  openOverlay('Edit Skill: ' + name, content, 'markdown', 'skill', async c => {
    await api('PUT', '/skills/' + encodeURIComponent(name), { content: c }); toast('Skill saved'); loadSkills();
  });
}
async function deleteSkill(name) {
  if (!await confirmDlg('Delete Skill', `Delete skill "${name}"? This cannot be undone.`)) return;
  await api('DELETE', '/skills/' + encodeURIComponent(name)); toast('Skill deleted'); loadSkills();
}

// ===== AGENTS =====
async function loadAgents() {
  const items = await api('GET', '/agents');
  renderItemGrid('agents-grid', items, 'agent', '🤖', editAgent, deleteAgent);
  document.getElementById('badge-agents').textContent = items.length;
}
document.getElementById('newAgentBtn').onclick = () => {
  showTemplateGallery('agent', (name, content) => {
    openOverlay('New Agent: ' + name, content, 'markdown', 'agent', async c => {
      await api('POST', '/agents', { name, content: c }); toast('Agent created: ' + name); loadAgents();
    }, true);
  });
};
async function editAgent(name) {
  const { content } = await api('GET', '/agents/' + encodeURIComponent(name));
  openOverlay('Edit Agent: ' + name, content, 'markdown', 'agent', async c => {
    await api('PUT', '/agents/' + encodeURIComponent(name), { content: c }); toast('Agent saved'); loadAgents();
  });
}
async function deleteAgent(name) {
  if (!await confirmDlg('Delete Agent', `Delete agent "${name}"?`)) return;
  await api('DELETE', '/agents/' + encodeURIComponent(name)); toast('Agent deleted'); loadAgents();
}

// ===== AGENT STORE =====
let _agentStoreData = [];

;(function () {
  document.querySelectorAll('.agent-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.agent-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const isStore = tab.dataset.agentTab === 'store';
      document.getElementById('agents-installed-panel').style.display = isStore ? 'none' : '';
      document.getElementById('agents-store-panel').style.display    = isStore ? '' : 'none';
      document.getElementById('agentsInstalledActions').style.display = isStore ? 'none' : '';
      if (isStore) { loadAgentStoreSources(); if (!_agentStoreData.length) loadAgentStore(); }
    };
  });
  document.getElementById('agentStoreSearch')?.addEventListener('input', () => renderAgentStoreGrid(_agentStoreData));
  document.getElementById('agentStoreSourceFilter')?.addEventListener('change', () => renderAgentStoreGrid(_agentStoreData));
  document.getElementById('agentStoreRefresh')?.addEventListener('click', () => { _agentStoreData = []; loadAgentStore(); });
})();

async function loadAgentStoreSources() {
  const sources = await api('GET', '/agent-store/sources');
  const filter  = document.getElementById('agentStoreSourceFilter');
  const cur     = filter.value;
  filter.innerHTML = '<option value="">All Sources</option>' +
    sources.map(s => `<option value="${escHtml(s.id)}"${s.id === cur ? ' selected' : ''}>${escHtml(s.icon || '📦')} ${escHtml(s.name)}</option>`).join('');
  renderAgentSourcesList(sources);
}

function renderAgentSourcesList(sources) {
  const el = document.getElementById('agentSourcesList');
  if (!el) return;
  el.innerHTML = sources.map(s => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:16px">${escHtml(s.icon || '📦')}</span>
      <span style="flex:1;font-size:13px">${escHtml(s.name)}</span>
      <span style="font-size:11px;color:var(--text-muted)">${escHtml(s.repo)}</span>
      ${s.builtin ? '<span class="badge" style="font-size:10px">builtin</span>' :
        `<label class="toggle-switch" style="transform:scale(.8)"><input type="checkbox" ${s.enabled !== false ? 'checked' : ''} data-src-toggle="${escHtml(s.id)}"><span class="slider"></span></label>
         <button class="btn btn-secondary btn-sm" data-src-del="${escHtml(s.id)}" style="color:var(--danger)">✕</button>`}
    </div>`).join('');
  el.querySelectorAll('[data-src-toggle]').forEach(cb => {
    cb.onchange = async () => {
      try { await api('PUT', `/agent-store/sources/${cb.dataset.srcToggle}/toggle`); _agentStoreData = []; loadAgentStore(); }
      catch (e) { toast(e.message, 'error'); cb.checked = !cb.checked; }
    };
  });
  el.querySelectorAll('[data-src-del]').forEach(btn => {
    btn.onclick = async () => {
      if (!await confirmDlg('Remove Source', 'Remove this source? Items already installed from it stay in place.')) return;
      try { await api('DELETE', `/agent-store/sources/${btn.dataset.srcDel}`); _agentStoreData = []; loadAgentStoreSources(); loadAgentStore(); }
      catch (e) { toast(e.message, 'error'); }
    };
  });
}

async function loadAgentStore() {
  const grid = document.getElementById('agents-store-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="text-muted" style="padding:32px;text-align:center">⏳ Fetching agents from GitHub…</div>';
  try {
    _agentStoreData = await api('GET', '/agent-store/browse');
    renderAgentStoreGrid(_agentStoreData);
  } catch (e) { grid.innerHTML = `<div class="text-muted" style="padding:24px;text-align:center">⚠️ ${escHtml(e.message)}</div>`; }
}

function renderAgentStoreGrid(agents) {
  const grid    = document.getElementById('agents-store-grid');
  const search  = (document.getElementById('agentStoreSearch')?.value || '').toLowerCase();
  const srcId   = document.getElementById('agentStoreSourceFilter')?.value || '';
  const visible = agents.filter(a =>
    (!search || a.name.toLowerCase().includes(search) || (a.description || '').toLowerCase().includes(search)) &&
    (!srcId || a.sourceId === srcId)
  );
  if (!visible.length) { grid.innerHTML = '<div class="text-muted" style="padding:32px;text-align:center">No agents found.</div>'; return; }
  grid.innerHTML = visible.map(a => `
    <div class="skill-card" id="astore-${escHtml(a.id)}">
      <div class="skill-card-header">
        <span class="skill-card-icon">🤖</span>
        <span class="skill-card-name">${escHtml(a.displayName || a.name)}</span>
        <span class="badge" style="font-size:10px;margin-left:auto">${escHtml(a.sourceLabel)}</span>
      </div>
      <div class="skill-card-desc">${escHtml(a.description || 'No description.')}</div>
      <div class="skill-card-actions">
        <button class="btn-explain" onclick="showExplainer('${escHtml(a.displayName||a.name)}','Name: ${escHtml(a.displayName||a.name)}\\nDescription: ${escHtml(a.description||'No description')}','agent',{sourceLabel:'${escHtml(a.sourceLabel||'')}'})" title="Explain with AI">🤖 Explain</button>
        ${a.installed
          ? `<span class="badge badge-success" style="font-size:11px">✓ Installed</span>
             <button class="btn btn-secondary btn-sm" data-agent-store-id="${escHtml(a.id)}" data-agent-name="${escHtml(a.name)}" data-source-id="${escHtml(a.sourceId)}">↓ Reinstall</button>`
          : `<button class="btn btn-primary btn-sm" data-agent-store-id="${escHtml(a.id)}" data-agent-name="${escHtml(a.name)}" data-source-id="${escHtml(a.sourceId)}">↓ Install</button>`}
        <a href="${escHtml(a.githubUrl)}" target="_blank" class="btn btn-secondary btn-sm">GitHub ↗</a>
      </div>
    </div>`).join('');

  grid.querySelectorAll('[data-agent-store-id]').forEach(btn => {
    btn.onclick = async () => {
      const agentName = btn.dataset.agentName;
      const sourceId  = btn.dataset.sourceId;
      const orig = btn.textContent;
      btn.textContent = '⏳ Installing…'; btn.disabled = true;
      try {
        const r = await api('POST', '/agent-store/install', { agentName, sourceId });
        const agent = agents.find(a => a.id === btn.dataset.agentStoreId);
        toast(`${agent?.displayName || agentName} installed from ${r.source || 'store'} — visible in the Agents tab`);
        if (agent) agent.installed = true;
        const card = document.getElementById('astore-' + btn.dataset.agentStoreId);
        if (card) {
          const actions = card.querySelector('.skill-card-actions');
          actions.innerHTML = `<span class="badge badge-success" style="font-size:11px">✓ Installed</span>
            <button class="btn btn-secondary btn-sm" data-agent-store-id="${escHtml(btn.dataset.agentStoreId)}" data-agent-name="${escHtml(agentName)}" data-source-id="${escHtml(sourceId)}">↓ Reinstall</button>
            <a href="${escHtml(agent?.githubUrl || '')}" target="_blank" class="btn btn-secondary btn-sm">GitHub ↗</a>`;
          actions.querySelector('[data-agent-store-id]').onclick = btn.onclick;
        }
        loadAgents();
      } catch (e) {
        toast('Install failed: ' + e.message, 'error');
        btn.textContent = orig; btn.disabled = false;
      }
    };
  });
}

async function addAgentSource() {
  const name = document.getElementById('agentSrcName').value.trim();
  const repo = document.getElementById('agentSrcRepo').value.trim();
  const p    = document.getElementById('agentSrcPath').value.trim();
  const branch = document.getElementById('agentSrcBranch').value.trim();
  if (!name || !repo) { toast('Name and repo are required', 'error'); return; }
  try {
    await api('POST', '/agent-store/sources', { name, repo, path: p, branch });
    toast('Source added'); _agentStoreData = []; loadAgentStoreSources(); loadAgentStore();
    ['agentSrcName','agentSrcRepo','agentSrcPath','agentSrcBranch'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  } catch (e) { toast(e.message, 'error'); }
}

// ===== HOOK STORE =====
let _hookStoreData = [];

;(function () {
  document.querySelectorAll('.hook-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.hook-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const isStore = tab.dataset.hookTab === 'store';
      document.getElementById('hooks-installed-panel').style.display = isStore ? 'none' : '';
      document.getElementById('hooks-store-panel').style.display    = isStore ? '' : 'none';
      document.getElementById('hooksInstalledActions').style.display = isStore ? 'none' : '';
      if (isStore) { loadHookStoreSources(); if (!_hookStoreData.length) loadHookStore(); }
    };
  });
  document.getElementById('hookStoreSearch')?.addEventListener('input', () => renderHookStoreGrid(_hookStoreData));
  document.getElementById('hookStoreSourceFilter')?.addEventListener('change', () => renderHookStoreGrid(_hookStoreData));
  document.getElementById('hookStoreRefresh')?.addEventListener('click', () => { _hookStoreData = []; loadHookStore(); });
})();

async function loadHookStoreSources() {
  const sources = await api('GET', '/hook-store/sources');
  const filter  = document.getElementById('hookStoreSourceFilter');
  const cur     = filter.value;
  filter.innerHTML = '<option value="">All Sources</option>' +
    sources.map(s => `<option value="${escHtml(s.id)}"${s.id === cur ? ' selected' : ''}>${escHtml(s.icon || '📦')} ${escHtml(s.name)}</option>`).join('');
  renderHookSourcesList(sources);
}

function renderHookSourcesList(sources) {
  const el = document.getElementById('hookSourcesList');
  if (!el) return;
  el.innerHTML = sources.map(s => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:16px">${escHtml(s.icon || '📦')}</span>
      <span style="flex:1;font-size:13px">${escHtml(s.name)}</span>
      <span style="font-size:11px;color:var(--text-muted)">${escHtml(s.repo)}</span>
      ${s.builtin ? '<span class="badge" style="font-size:10px">builtin</span>' :
        `<label class="toggle-switch" style="transform:scale(.8)"><input type="checkbox" ${s.enabled !== false ? 'checked' : ''} data-src-toggle="${escHtml(s.id)}"><span class="slider"></span></label>
         <button class="btn btn-secondary btn-sm" data-src-del="${escHtml(s.id)}" style="color:var(--danger)">✕</button>`}
    </div>`).join('');
  el.querySelectorAll('[data-src-toggle]').forEach(cb => {
    cb.onchange = async () => {
      try { await api('PUT', `/hook-store/sources/${cb.dataset.srcToggle}/toggle`); _hookStoreData = []; loadHookStore(); }
      catch (e) { toast(e.message, 'error'); cb.checked = !cb.checked; }
    };
  });
  el.querySelectorAll('[data-src-del]').forEach(btn => {
    btn.onclick = async () => {
      if (!await confirmDlg('Remove Source', 'Remove this source? Items already installed from it stay in place.')) return;
      try { await api('DELETE', `/hook-store/sources/${btn.dataset.srcDel}`); _hookStoreData = []; loadHookStoreSources(); loadHookStore(); }
      catch (e) { toast(e.message, 'error'); }
    };
  });
}

async function loadHookStore() {
  const grid = document.getElementById('hooks-store-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="text-muted" style="padding:32px;text-align:center">⏳ Fetching hooks from GitHub…</div>';
  try {
    _hookStoreData = await api('GET', '/hook-store/browse');
    renderHookStoreGrid(_hookStoreData);
  } catch (e) { grid.innerHTML = `<div class="text-muted" style="padding:24px;text-align:center">⚠️ ${escHtml(e.message)}</div>`; }
}

function renderHookStoreGrid(hooks) {
  const grid    = document.getElementById('hooks-store-grid');
  const search  = (document.getElementById('hookStoreSearch')?.value || '').toLowerCase();
  const srcId   = document.getElementById('hookStoreSourceFilter')?.value || '';
  const visible = hooks.filter(h =>
    (!search || h.name.toLowerCase().includes(search) || (h.description || '').toLowerCase().includes(search)) &&
    (!srcId || h.sourceId === srcId)
  );
  if (!visible.length) { grid.innerHTML = '<div class="text-muted" style="padding:32px;text-align:center">No hooks found.</div>'; return; }
  grid.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;padding:8px;background:var(--surface);border-radius:6px;border:1px solid var(--border)">
    💡 Installing a hook copies the <code>.mjs</code> file to <code>~/.claude/hooks/</code>. Wire it to an event in the <strong>Hooks → Installed</strong> tab afterwards.
  </div>` + visible.map(h => `
    <div class="skill-card" id="hstore-${escHtml(h.id)}">
      <div class="skill-card-header">
        <span class="skill-card-icon">🪝</span>
        <span class="skill-card-name">${escHtml(h.displayName || h.name)}</span>
        <span class="badge" style="font-size:10px;margin-left:auto">${escHtml(h.sourceLabel)}</span>
      </div>
      <div class="skill-card-desc">${escHtml(h.description || 'No description.')}</div>
      <div class="skill-card-actions">
        <button class="btn-explain" onclick="showExplainer('${escHtml(h.displayName||h.name)}','Name: ${escHtml(h.displayName||h.name)}\\nDescription: ${escHtml(h.description||'No description')}','hook',{ext:'${escHtml(h.ext||'.py')}',sourceLabel:'${escHtml(h.sourceLabel||'')}'})" title="Explain with AI">🤖 Explain</button>
        ${h.installed
          ? `<span class="badge badge-success" style="font-size:11px">✓ Installed</span>
             <button class="btn btn-secondary btn-sm" data-hook-store-id="${escHtml(h.id)}" data-hook-name="${escHtml(h.name)}" data-source-id="${escHtml(h.sourceId)}">↓ Reinstall</button>`
          : `<button class="btn btn-primary btn-sm" data-hook-store-id="${escHtml(h.id)}" data-hook-name="${escHtml(h.name)}" data-source-id="${escHtml(h.sourceId)}">↓ Install</button>`}
        <a href="${escHtml(h.githubUrl)}" target="_blank" class="btn btn-secondary btn-sm">GitHub ↗</a>
      </div>
    </div>`).join('');

  grid.querySelectorAll('[data-hook-store-id]').forEach(btn => {
    btn.onclick = async () => {
      const hookName = btn.dataset.hookName;
      const sourceId = btn.dataset.sourceId;
      const orig = btn.textContent;
      btn.textContent = '⏳ Installing…'; btn.disabled = true;
      try {
        const r   = await api('POST', '/hook-store/install', { hookName, sourceId });
        const hook = hooks.find(h => h.id === btn.dataset.hookStoreId);
        const displayName = hook?.displayName || hookName;
        toast(`${displayName} installed (${r.ext || '.mjs'}) — now wire it to a lifecycle event`);
        if (hook) hook.installed = true;
        const card = document.getElementById('hstore-' + btn.dataset.hookStoreId);
        if (card) {
          const actions = card.querySelector('.skill-card-actions');
          actions.innerHTML = `<span class="badge badge-success" style="font-size:11px">✓ Installed</span>
            <button class="btn btn-primary btn-sm" onclick="navigate('hooks');document.querySelector('[data-hook-tab=installed]')?.click()">→ Wire to Event</button>
            <button class="btn btn-secondary btn-sm" data-hook-store-id="${escHtml(btn.dataset.hookStoreId)}" data-hook-name="${escHtml(hookName)}" data-source-id="${escHtml(sourceId)}">↓ Reinstall</button>`;
          actions.querySelector('[data-hook-store-id]').onclick = btn.onclick;
        }
        loadHooks();
      } catch (e) {
        toast('Install failed: ' + e.message, 'error');
        btn.textContent = orig; btn.disabled = false;
      }
    };
  });
}

async function addHookSource() {
  const name   = document.getElementById('hookSrcName').value.trim();
  const repo   = document.getElementById('hookSrcRepo').value.trim();
  const p      = document.getElementById('hookSrcPath').value.trim();
  const branch = document.getElementById('hookSrcBranch').value.trim();
  const ext    = document.getElementById('hookSrcExt').value.trim();
  if (!name || !repo) { toast('Name and repo are required', 'error'); return; }
  try {
    await api('POST', '/hook-store/sources', { name, repo, path: p, branch, ext });
    toast('Source added'); _hookStoreData = []; loadHookStoreSources(); loadHookStore();
    ['hookSrcName','hookSrcRepo','hookSrcPath','hookSrcBranch','hookSrcExt'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  } catch (e) { toast(e.message, 'error'); }
}

// ===== COMMANDS =====
async function loadCommands() {
  const items = await api('GET', '/commands');
  // commands show /name prefix
  const mapped = items.map(c => ({ ...c, displayName: '/' + c.name }));
  renderItemGrid('commands-grid', mapped, 'command', '⌨️', editCommand, deleteCommand, true);
  document.getElementById('badge-commands').textContent = items.length;
}
document.getElementById('newCommandBtn').onclick = () => {
  showTemplateGallery('command', (name, content) => {
    openOverlay('New Command: /' + name, content, 'markdown', 'command', async c => {
      await api('POST', '/commands', { name, content: c }); toast('Command /' + name + ' created'); loadCommands();
    }, true);
  });
};
async function editCommand(name) {
  const cmds = await api('GET', '/commands');
  const cmd  = cmds.find(c => c.name === name);
  openOverlay('Edit Command: /' + name, cmd?.content || '', 'markdown', 'command', async c => {
    await api('PUT', '/commands/' + encodeURIComponent(name), { content: c }); toast('Command saved'); loadCommands();
  });
}
async function deleteCommand(name) {
  if (!await confirmDlg('Delete Command', `Delete command /${name}?`)) return;
  await api('DELETE', '/commands/' + encodeURIComponent(name)); toast('Command deleted'); loadCommands();
}

// ===== EXPLAIN WITH AI =====
let _explainText = '';

function simpleMarkdown(md) {
  return md
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/```[\s\S]*?```/g, m => `<pre>${m.slice(3, m.length - 3).replace(/^[a-z]*\n/, '')}</pre>`)
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]+?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hup])(.*)/gm, (l, t) => t.trim() ? t : '');
}

const TYPE_META = {
  skill:    { icon: '🧩', label: 'Skill',    cls: 'esp-skill'    },
  agent:    { icon: '🤖', label: 'Agent',    cls: 'esp-agent'    },
  hook:     { icon: '🪝', label: 'Hook',     cls: 'esp-hook'     },
  workflow: { icon: '🔀', label: 'Workflow', cls: 'esp-workflow'  },
  command:  { icon: '⌨️', label: 'Command',  cls: 'esp-command'  },
};

function renderExplainContent(text) {
  const EMOJI_RE = /^(📌|⚙️|🎯|💡|⚠️)\s+(.+)$/;
  const lines = text.split('\n');
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(EMOJI_RE);
    if (m) { if (cur) sections.push(cur); cur = { icon: m[1], title: m[2], lines: [] }; }
    else if (cur) cur.lines.push(line);
    else if (line.trim()) { if (!sections.length) sections.push({ icon: '', title: '', lines: [] }); sections[0].lines.push(line); }
  }
  if (cur) sections.push(cur);
  return sections.map(s => {
    const body = simpleMarkdown(s.lines.join('\n').trim());
    if (!body) return '';
    if (!s.icon) return `<div class="explain-section"><div class="explain-section-body">${body}</div></div>`;
    return `<div class="explain-section">
      <div class="explain-section-head">${s.icon}&nbsp;${escHtml(s.title)}</div>
      <div class="explain-section-body">${body}</div>
    </div>`;
  }).filter(Boolean).join('');
}

async function showExplainer(title, content, type, meta = {}) {
  const modal  = document.getElementById('explainModal');
  const body   = document.getElementById('explainModalBody');
  const pills  = document.getElementById('explainScopePills');
  const tm     = TYPE_META[type] || { icon: '📄', label: type || 'Item', cls: 'esp-meta' };

  document.getElementById('explainModalTitle').textContent = `${tm.icon} ${title}`;

  // Scope pills
  const pillsHtml = [`<span class="explain-scope-pill ${tm.cls}">${tm.label}</span>`];
  if (meta.scope)       pillsHtml.push(`<span class="explain-scope-pill esp-meta">${escHtml(meta.scope)}</span>`);
  if (meta.ext)         pillsHtml.push(`<span class="explain-scope-pill esp-meta">${escHtml(meta.ext)}</span>`);
  if (meta.sourceLabel) pillsHtml.push(`<span class="explain-scope-pill esp-meta">${escHtml(meta.sourceLabel)}</span>`);
  pills.innerHTML = pillsHtml.join('');

  // Skeleton loading
  body.innerHTML = `<div class="explain-loading">
    <div class="explain-skeleton" style="width:60%"></div>
    <div class="explain-skeleton" style="width:90%"></div>
    <div class="explain-skeleton" style="width:75%"></div>
    <div class="explain-skeleton" style="width:55%;margin-top:8px"></div>
    <div class="explain-skeleton" style="width:85%"></div>
    <div class="explain-skeleton" style="width:70%"></div>
  </div>`;
  _explainText = '';
  modal.classList.add('open');

  try {
    const cfg = await api('GET', '/ai-config');
    const provider = cfg.claudeCli ? 'claude' : (cfg.hasOpenRouterKey ? 'openrouter' : null);
    if (!provider) {
      body.innerHTML = '<div style="padding:16px;color:var(--danger)">No AI provider configured. Add Claude CLI or OpenRouter key in Settings → AI Generation.</div>';
      return;
    }
    const typeLabel = `${tm.label}${meta.scope ? ' (' + meta.scope + ')' : ''}`;
    const { explanation } = await api('POST', '/ai/explain', { content, type: typeLabel, provider });
    _explainText = explanation;
    body.innerHTML = renderExplainContent(explanation);
    if (!body.innerHTML.trim()) body.innerHTML = `<div class="explain-section-body">${simpleMarkdown(explanation)}</div>`;
  } catch (e) {
    body.innerHTML = `<div style="padding:16px;color:var(--danger)">${escHtml(e.message)}</div>`;
  }
}
document.getElementById('explainModalClose').onclick  = () => document.getElementById('explainModal').classList.remove('open');
document.getElementById('explainModalClose2').onclick = () => document.getElementById('explainModal').classList.remove('open');
document.getElementById('explainModalCopy').onclick   = () => {
  if (_explainText) navigator.clipboard.writeText(_explainText).then(() => toast('Explanation copied'));
};

// ===== WORKFLOW WIZARD =====
// ===== WORKFLOW WIZARD (4-step: Goal → Plan → Build → Install) =====
let _wfState = { goal: '', context: '', plan: null, components: [], provider: 'claude-cli', builtComponents: [] };
const WF_INSTALL_API = { skill: 'skills', agent: 'agents', hook: 'hooks/files', command: 'commands' };

const _wfRefs = new Set();

function openWorkflowWizard() {
  _wfState = { goal: '', context: '', plan: null, components: [], provider: 'claude-cli', builtComponents: [] };
  document.getElementById('wfGoalInput').value = '';
  const wfRefUrl = document.getElementById('wfRefUrl'); if (wfRefUrl) wfRefUrl.value = '';
  loadRefChips('wfRefChips', _wfRefs);
  document.getElementById('wfRepoPath').value    = '';
  document.getElementById('wfTechStack').value   = '';
  document.getElementById('wfTrigger').value     = '';
  const wfDom   = document.getElementById('wfDomain');      if (wfDom)   wfDom.value   = '';
  const wfPersp = document.getElementById('wfPerspective'); if (wfPersp) wfPersp.value = '';
  document.getElementById('wfGenerateBtn').textContent = 'Generate Plan →';
  document.getElementById('wfGenerateBtn').disabled    = false;
  document.getElementById('wfBuildBtn').style.display  = 'none';
  document.getElementById('workflowWizard').classList.add('open');
  showWfStep(1);
  // Detect AI providers
  api('GET', '/ai-config').then(cfg => {
    const cliEl = document.getElementById('wfCliStatus');
    const orEl  = document.getElementById('wfOrStatus');
    if (cliEl) { cliEl.textContent = cfg.claudeCli ? '✓ Ready' : '✗ Not installed'; cliEl.style.color = cfg.claudeCli ? 'var(--success)' : 'var(--danger)'; }
    if (orEl)  { orEl.textContent  = cfg.hasOpenRouterKey ? '✓ Key set' : 'No key'; orEl.style.color = cfg.hasOpenRouterKey ? 'var(--success)' : 'var(--text-muted)'; }
    setWfProvider(cfg.claudeCli ? 'claude-cli' : 'openrouter');
  }).catch(() => {});
}

function setWfProvider(p) {
  _wfState.provider = p;
  document.getElementById('wfProviderCli').classList.toggle('active', p === 'claude-cli');
  document.getElementById('wfProviderOr').classList.toggle('active', p === 'openrouter');
}
window.setWfProvider = setWfProvider;

function closeWorkflowWizard() { document.getElementById('workflowWizard').classList.remove('open'); }

function showWfStep(n) {
  [1,2,3,4].forEach(i => {
    document.getElementById('wfStep' + i).style.display = i === n ? '' : 'none';
    const dot = document.querySelector(`.wf-step-dot[data-step="${i}"]`);
    if (dot) { dot.classList.toggle('active', i === n); dot.classList.toggle('done', i < n); }
  });
}

document.getElementById('wfWizardClose').onclick  = closeWorkflowWizard;
document.getElementById('wfWizardCancel').onclick = closeWorkflowWizard;
document.getElementById('wfDoneBtn').onclick = () => { closeWorkflowWizard(); loadWorkflows(); };
document.getElementById('wfBackToGoal').onclick = () => showWfStep(1);
document.getElementById('wfBuildBtn').onclick  = buildWfComponents;
document.getElementById('wfInstallBtn').onclick = runWfInstall;
document.querySelectorAll('.wf-goal-examples [data-goal]').forEach(btn => {
  btn.onclick = () => { document.getElementById('wfGoalInput').value = btn.dataset.goal; };
});

// Step 1 → Step 2: Generate plan
document.getElementById('wfGenerateBtn').onclick = async () => {
  const goal = document.getElementById('wfGoalInput').value.trim();
  if (!goal) { toast('Please describe a workflow goal first', 'error'); return; }

  const repo        = document.getElementById('wfRepoPath').value.trim();
  const stack       = document.getElementById('wfTechStack').value.trim();
  const trigger     = document.getElementById('wfTrigger').value;
  const domain      = document.getElementById('wfDomain')?.value.trim();
  const perspective = document.getElementById('wfPerspective')?.value.trim();
  const ctxParts = [];
  if (repo)        ctxParts.push(`Repository/project: ${repo}`);
  if (stack)       ctxParts.push(`Tech stack: ${stack}`);
  if (domain)      ctxParts.push(`Domain: ${domain}`);
  if (perspective) ctxParts.push(`Assume the perspective of: ${perspective}`);
  if (trigger)     ctxParts.push(`Trigger preference: ${trigger}`);

  const btn = document.getElementById('wfGenerateBtn');
  btn.textContent = 'Generating Plan…'; btn.disabled = true;
  showWfStep(2);
  document.getElementById('wfPlanHeader').innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)">🤖 Thinking about your workflow…</div>';
  document.getElementById('wfComponentList').innerHTML = '';
  document.getElementById('wfBuildBtn').style.display = 'none';

  try {
    _wfState.goal    = goal;
    _wfState.context = ctxParts.join('\n');
    const apiProvider = _wfState.provider === 'claude-cli' ? 'claude' : 'openrouter';
    _wfState.plan = await api('POST', '/ai/generate-workflow-plan', {
      goal,
      context: _wfState.context,
      provider: apiProvider,
      mcpRefs: [..._wfRefs],
      referenceUrl: document.getElementById('wfRefUrl')?.value.trim() || undefined,
    });
    _wfState.components = _wfState.plan.components.map(c => ({ ...c, removed: false }));
    renderWfPlan();
  } catch (e) {
    document.getElementById('wfPlanHeader').innerHTML = `<div style="color:var(--danger);padding:12px">${escHtml(e.message)}</div>`;
    showWfStep(1);
  } finally { btn.textContent = 'Generate Plan →'; btn.disabled = false; }
};

function renderWfPlan() {
  const plan   = _wfState.plan;
  const active = _wfState.components.filter(c => !c.removed).length;
  document.getElementById('wfPlanHeader').innerHTML = `
    <div style="font-size:15px;font-weight:700;margin-bottom:4px">${escHtml(plan.title || plan.name)}</div>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:10px">${escHtml(plan.description)}</div>
    <div style="font-size:12px;color:var(--text-dim)">${active} component${active !== 1 ? 's' : ''} — remove any you don't need, then click <strong>Build Components</strong></div>`;
  document.getElementById('wfBuildBtn').style.display = '';

  const list = document.getElementById('wfComponentList');
  list.innerHTML = _wfState.components.map((c, i) => `
    <div class="wf-review-card" id="wfpc-${i}">
      <div class="wf-review-card-top">
        <span class="badge ${WF_TYPE_CLASS[c.type] || 'badge-muted'}">${c.type}</span>
        <input class="wf-review-name-input" value="${escHtml(c.name)}" data-name-idx="${i}" spellcheck="false">
        <div class="wf-review-card-actions">
          <button class="btn btn-xs btn-danger" data-remove-idx="${i}">✕ Remove</button>
        </div>
      </div>
      <div class="wf-review-card-desc">${escHtml(c.description)}</div>
    </div>`).join('');

  list.querySelectorAll('[data-name-idx]').forEach(inp => {
    inp.onchange = () => { _wfState.components[+inp.dataset.nameIdx].name = inp.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'); };
  });
  list.querySelectorAll('[data-remove-idx]').forEach(btn => {
    btn.onclick = () => {
      _wfState.components[+btn.dataset.removeIdx].removed = true;
      document.getElementById(`wfpc-${btn.dataset.removeIdx}`).style.cssText = 'opacity:.3;pointer-events:none';
    };
  });
}

// Step 2 → Step 3: Build each component using type-specific meta prompts
async function buildWfComponents() {
  const active = _wfState.components.filter(c => !c.removed);
  if (!active.length) { toast('No components selected', 'error'); return; }
  document.getElementById('wfBuildBtn').disabled = true;
  showWfStep(3);
  document.getElementById('wfReviewList').style.display = 'none';
  document.getElementById('wfInstallBtn').style.display = 'none';

  const buildList = document.getElementById('wfBuildList');
  buildList.innerHTML = active.map((c, i) => `
    <div class="wf-install-row" id="wf-brow-${i}">
      <span class="wf-install-icon" id="wf-bicon-${i}">⏳</span>
      <div style="flex:1"><div class="wf-install-name">${escHtml(c.name)}</div><div><span class="badge ${WF_TYPE_CLASS[c.type] || 'badge-muted'}">${c.type}</span></div></div>
      <span id="wf-bstatus-${i}" style="font-size:12px;color:var(--text-dim)">Waiting…</span>
    </div>`).join('');

  const apiProvider = _wfState.provider === 'claude-cli' ? 'claude' : 'openrouter';
  const goalCtx = _wfState.context ? `\nContext: ${_wfState.context}` : '';

  for (let i = 0; i < active.length; i++) {
    const comp = active[i];
    const iconEl = document.getElementById(`wf-bicon-${i}`);
    const statEl = document.getElementById(`wf-bstatus-${i}`);
    iconEl.textContent = '🔄'; statEl.textContent = 'Generating…';
    try {
      if (comp.type === 'command') {
        comp.content = `# /${comp.name}\n\n${comp.description}\n\n## Usage\n\nType \`/${comp.name}\` in Claude to run this command.\n\n## Instructions\n\n${comp.description}\n`;
      } else {
        const prompt = `${comp.name} — ${comp.description}\n\nThis component is part of the "${_wfState.plan.title || _wfState.plan.name}" workflow: ${_wfState.plan.description}.${goalCtx}`;
        const result = await api('POST', '/ai/generate-skill', { prompt, provider: apiProvider, type: comp.type });
        comp.content = result.content;
      }
      iconEl.textContent = '✅'; statEl.textContent = 'Done'; statEl.style.color = 'var(--success)';
    } catch (e) {
      comp.content = `# ${comp.name}\n\nFailed to generate: ${e.message}\n\nPlease edit this manually.`;
      iconEl.textContent = '⚠️'; statEl.textContent = e.message.slice(0, 40); statEl.style.color = 'var(--danger)';
    }
  }

  _wfState.builtComponents = active;
  renderWfReview(active);
  document.getElementById('wfInstallBtn').style.display = '';
}

function renderWfReview(components) {
  const list = document.getElementById('wfReviewList');
  list.style.display = '';
  list.innerHTML = `<div class="subhead">Review &amp; Edit Before Installing</div>`
    + components.map((c, i) => `
    <div class="wf-review-card" id="wfrc-${i}">
      <div class="wf-review-card-top">
        <span class="badge ${WF_TYPE_CLASS[c.type] || 'badge-muted'}">${c.type}</span>
        <input class="wf-review-name-input" value="${escHtml(c.name)}" data-rn-idx="${i}" spellcheck="false">
        <div class="wf-review-card-actions">
          <button class="btn btn-xs btn-ghost" data-rpv-idx="${i}">👁 Preview</button>
          <button class="btn btn-xs btn-secondary" data-red-idx="${i}">Edit</button>
        </div>
      </div>
      <div class="wf-review-card-desc">${escHtml(c.description)}</div>
      <pre class="wf-review-card-preview" data-rpr-idx="${i}">${escHtml(c.content || '')}</pre>
    </div>`).join('');

  list.querySelectorAll('[data-rn-idx]').forEach(inp => {
    inp.onchange = () => { components[+inp.dataset.rnIdx].name = inp.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'); };
  });
  list.querySelectorAll('[data-rpv-idx]').forEach(btn => {
    btn.onclick = () => {
      const card = btn.closest('.wf-review-card'); card.classList.toggle('expanded');
      btn.textContent = card.classList.contains('expanded') ? '▲ Collapse' : '👁 Preview';
    };
  });
  list.querySelectorAll('[data-red-idx]').forEach(btn => {
    btn.onclick = () => {
      const idx  = +btn.dataset.redIdx;
      const comp = components[idx];
      const lang = comp.type === 'hook' ? 'javascript' : 'markdown';
      // Editor opens at z-index 230 (above wizard 210) — wizard stays visible underneath
      openOverlay(`Edit ${comp.type}: ${comp.name}`, comp.content || '', lang, comp.type, async (newContent) => {
        components[idx].content = newContent;
        const pre = list.querySelector(`[data-rpr-idx="${idx}"]`);
        if (pre) pre.textContent = newContent;
        toast(`${comp.name} updated`);
      });
    };
  });
}

// Step 3 → Step 4: Install all built components
// ===== WORKFLOW USAGE / INVOCATION HELPERS =====
function buildWorkflowOneShotPrompt(wf) {
  return `${wf.description || wf.title || wf.name}. Use these installed components where relevant: ${(wf.components || []).map(c => `${c.type} "${c.name}"`).join(', ')}.`;
}

function buildWorkflowOneShotCommand(wf) {
  const q = s => `'` + String(s).replace(/'/g, `'\\''`) + `'`;
  return `claude -p ${q(buildWorkflowOneShotPrompt(wf))} --dangerously-skip-permissions --output-format stream-json --verbose > ${(wf.name || 'workflow')}-run.jsonl`;
}

// End-to-end invocation instructions for a workflow, from its components
function buildWorkflowUsageHtml(wf) {
  const by = t => (wf.components || []).filter(c => c.type === t);
  const rows = [];
  by('command').forEach(c => rows.push(`<li>Type <code>/${escHtml(c.name)}</code> in any Claude Code session to trigger it manually. ${escHtml(c.description || '')}</li>`));
  by('skill').forEach(c => rows.push(`<li>Invoke the <strong>${escHtml(c.name)}</strong> skill with <code>/${escHtml(c.name)}</code>, or just ask for it naturally — Claude auto-triggers it when your request matches its description.</li>`));
  by('agent').forEach(c => rows.push(`<li>The <strong>${escHtml(c.name)}</strong> agent is delegated to automatically when relevant, or say <em>"use the ${escHtml(c.name)} agent"</em>.</li>`));
  by('hook').forEach(c => rows.push(`<li>The <strong>${escHtml(c.name)}</strong> hook fires automatically${c.event ? ` on <code>${escHtml(c.event)}</code>${c.matcher ? ` (matcher <code>${escHtml(c.matcher)}</code>)` : ''}` : ' — wire it to an event in the Hooks section'} in every session. No action needed.</li>`));
  const cmd = buildWorkflowOneShotCommand(wf);
  return `
    <div style="font-weight:700;margin:14px 0 8px">🚀 How to invoke this workflow end to end</div>
    <ol class="wf-setup-steps" style="margin-bottom:12px">${rows.join('')}</ol>
    <div style="font-weight:650;font-size:13px;margin-bottom:6px">⚡ Fully automated one-shot (bypasses ALL permission prompts)</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">
      Run the whole workflow non-interactively — Claude executes every step, uses all tools without asking, and streams the full event log to a JSONL file.
      Use the <strong>▶ Run</strong> button on the workflow card, or from a terminal in your project folder:
    </div>
    <div style="display:flex;gap:6px;align-items:flex-start">
      <textarea readonly rows="3" class="wf-oneshot-cmd" style="flex:1;font-family:monospace;font-size:11px;background:var(--surface2)">${escHtml(cmd)}</textarea>
      <button class="btn btn-secondary btn-sm" data-copy-oneshot="${escHtml(cmd)}">Copy</button>
    </div>
    <div style="font-size:11px;color:var(--warning);margin-top:6px">⚠ <code>--dangerously-skip-permissions</code> means no confirmation prompts — only run in a project you trust it with.</div>`;
}

function wireOneShotCopyButtons(container) {
  container.querySelectorAll('[data-copy-oneshot]').forEach(b => {
    b.onclick = () => navigator.clipboard.writeText(b.dataset.copyOneshot).then(() => toast('One-shot command copied'));
  });
}

async function runWfInstall() {
  const components = _wfState.builtComponents;
  if (!components.length) { toast('Nothing to install', 'error'); return; }
  document.getElementById('wfInstallBtn').disabled = true;
  showWfStep(4);

  const installList = document.getElementById('wfInstallList');
  installList.innerHTML = components.map((c, i) => `
    <div class="wf-install-row" id="wf-irow-${i}">
      <span class="wf-install-icon" id="wf-iicon-${i}">⏳</span>
      <div style="flex:1"><div class="wf-install-name">${escHtml(c.name)}</div><div><span class="badge ${WF_TYPE_CLASS[c.type] || 'badge-muted'}">${c.type}</span></div></div>
      <span id="wf-istatus-${i}" style="font-size:12px;color:var(--text-dim)">Waiting…</span>
      <button class="btn btn-xs btn-ghost" id="wf-iview-${i}" style="display:none">👁 View</button>
    </div>`).join('');

  document.getElementById('wfSetupGuide').style.display = 'none';

  for (let i = 0; i < components.length; i++) {
    const comp    = components[i];
    const iconEl  = document.getElementById(`wf-iicon-${i}`);
    const statEl  = document.getElementById(`wf-istatus-${i}`);
    const viewBtn = document.getElementById(`wf-iview-${i}`);
    iconEl.textContent = '🔄'; statEl.textContent = 'Installing…';
    try {
      const body = { name: comp.name, content: comp.content };
      if (comp.type === 'hook') body.name = comp.name + '.mjs';
      await api('POST', '/' + WF_INSTALL_API[comp.type], body);
      iconEl.textContent = '✅'; statEl.textContent = 'Saved'; statEl.style.color = 'var(--success)';
      // Hooks must also be WIRED to their lifecycle event — a saved but unwired
      // hook never fires.
      if (comp.type === 'hook') {
        if (comp.event) {
          try {
            await api('POST', '/hooks/wire', { event: comp.event, matcher: comp.matcher || '', filename: comp.name + '.mjs' });
            statEl.textContent = `Saved · wired to ${comp.event}${comp.matcher ? ' (' + comp.matcher + ')' : ''}`;
          } catch (e) {
            statEl.textContent = 'Saved — wiring failed, wire manually in Hooks';
            statEl.style.color = 'var(--warning)';
          }
        } else {
          statEl.textContent = 'Saved — no event in plan, wire manually in Hooks';
          statEl.style.color = 'var(--warning)';
        }
      }
      // "View" button opens the file in the editor overlay (z=230) WITHOUT closing wizard (z=210)
      viewBtn.style.display = '';
      const snapshot = { ...comp }; // capture for closure
      viewBtn.onclick = () => {
        const lang    = snapshot.type === 'hook' ? 'javascript' : 'markdown';
        const apiName = snapshot.type === 'hook' ? snapshot.name + '.mjs' : snapshot.name;
        openOverlay(`${snapshot.type}: ${snapshot.name}`, snapshot.content || '', lang, snapshot.type, async (newContent) => {
          snapshot.content = newContent;
          await api('PUT', '/' + WF_INSTALL_API[snapshot.type] + '/' + encodeURIComponent(apiName), { content: newContent });
          toast(`${snapshot.name} saved`);
        });
      };
    } catch (e) {
      iconEl.textContent = '❌'; statEl.textContent = e.message.slice(0, 35); statEl.style.color = 'var(--danger)';
    }
  }

  // Persist the workflow so it appears under "Your Workflows"
  const plan = _wfState.plan || {};
  const wfRecord = {
    name: (plan.name || 'my-workflow').toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    title: plan.title || plan.name || 'My Workflow',
    description: plan.description || _wfState.goal || '',
    components: components.map(c => ({ type: c.type, name: c.name, description: c.description, event: c.event, matcher: c.matcher })),
    setupGuide: plan.setupGuide || [],
  };
  try { await api('POST', '/workflows', wfRecord); } catch (e) { toast('Workflow saved partially: ' + e.message, 'error'); }

  const guide = document.getElementById('wfSetupGuide');
  guide.style.display = '';
  guide.innerHTML = `
    <div class="wf-setup-guide">
      ${plan.setupGuide?.length ? `
        <div style="font-weight:700;margin-bottom:8px">📋 Setup Guide</div>
        <ol class="wf-setup-steps">${plan.setupGuide.map(s => `<li>${escHtml(s)}</li>`).join('')}</ol>` : ''}
      ${buildWorkflowUsageHtml(wfRecord)}
    </div>`;
  wireOneShotCopyButtons(guide);
  document.getElementById('wfDoneBtn').style.display = '';
}

// ===== SHARED CARD GRID RENDERER =====
function renderItemGrid(gridId, items, type, icon, onEdit, onDelete, useDisplayName = false, isFilterPass = false) {
  const grid = document.getElementById(gridId);
  if (!isFilterPass) grid._ctx = { items, type, icon, onEdit, onDelete, useDisplayName };

  // Findability: with many items, offer a filter box (created once, lives
  // OUTSIDE the grid so typing never loses focus on re-render).
  if (!isFilterPass) {
    let wrap = document.getElementById(gridId + '-filter');
    if (items.length > 8) {
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = gridId + '-filter';
        wrap.innerHTML = `<input type="search" placeholder="⌕ Filter ${type}s by name or description…" style="max-width:340px;width:100%">`;
        grid.parentNode.insertBefore(wrap, grid);
        wrap.querySelector('input').addEventListener('input', (e) => {
          const q = e.target.value.trim().toLowerCase();
          const c = grid._ctx;
          const subset = !q ? c.items : c.items.filter(it =>
            it.name.toLowerCase().includes(q) || (it.description || '').toLowerCase().includes(q));
          renderItemGrid(gridId, subset, c.type, c.icon, c.onEdit, c.onDelete, c.useDisplayName, true);
        });
      }
      wrap.style.display = '';
    } else if (wrap) {
      wrap.style.display = 'none';
    }
  }

  if (!items.length) {
    if (isFilterPass) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>No ${type}s match your filter.</p></div>`;
      return;
    }
    // Humphrey: an empty state should invite the first move, not just describe absence
    const labels = { skill: 'skill', agent: 'agent', command: 'command' };
    const descs = {
      skill:   'Skills extend Claude with reusable workflows and knowledge — applied automatically when your request matches, or via <code>/name</code>.',
      agent:   'Agents are specialised Claude instances with their own system prompt, model, and tool restrictions.',
      command: 'Commands create <code>/slash-commands</code>: markdown files whose content Claude follows when you type the command name.',
    };
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">${icon}</div>
      <h3>No ${labels[type] || type}s yet</h3>
      <p>${descs[type] || ''}</p>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="showSkillGenerator('${type}')">✨ Describe one — AI builds it</button>
        ${type !== 'command' ? `<button class="btn btn-secondary" onclick="document.querySelector('[data-${type}-tab=store]')?.click()">🏪 Browse the ${type} store</button>` : ''}
        <button class="btn btn-secondary" onclick="navigate('examples')">📚 See a worked example</button>
      </div>
    </div>`;
    return;
  }
  grid.innerHTML = items.map(item => {
    const displayName = useDisplayName ? (item.displayName || item.name) : item.name;
    const desc = item.description || (item.content ? item.content.replace(/^#+[^\n]*/gm, '').trim().slice(0, 100) : '');

    // Build metadata badges
    const badges = [];
    if (item.trigger) badges.push(`<span class="badge badge-muted" style="font-size:10px;padding:1px 6px">${escHtml(item.trigger)}</span>`);
    if (item.model)   badges.push(`<span class="badge badge-muted"  style="font-size:10px;padding:1px 6px">${escHtml(item.model.replace('claude-',''))}</span>`);
    if (item.tools && item.tools.length) badges.push(`<span class="badge badge-muted" style="font-size:10px;padding:1px 6px">🔒 ${item.tools.length} tools</span>`);
    if (item.locationLabel) badges.push(`<span class="badge badge-warning" style="font-size:10px;padding:1px 6px" title="Lives outside the ${type}s folder — shipped by a plugin or skill">📦 ${escHtml(item.locationLabel)}</span>`);

    return `
      <div class="skill-card type-${escHtml(type)}">
        <div class="skill-card-name">${icon} ${escHtml(displayName)}</div>
        <div class="skill-card-desc">${escHtml(desc)}</div>
        ${badges.length ? `<div class="skill-card-badges">${badges.join('')}</div>` : ''}
        <div class="skill-card-meta"><span>${item.size}</span><span>${fmtDate(item.modified)}</span></div>
        <div class="skill-card-actions">
          ${(type === 'skill' || type === 'agent' || type === 'command') && !item.external ? `<button class="btn btn-run btn-sm" data-run="${escHtml(item.name)}" title="Run one-shot, streaming JSONL output to a file">▶ Run</button>` : ''}
          <button class="btn btn-secondary btn-sm" data-edit="${escHtml(item.name)}"${item.external ? ` data-edit-path="${escHtml(item.path)}"` : ''} title="Edit">✎ Edit</button>
          <details class="more-menu">
            <summary title="More actions">⋯</summary>
            <div class="more-menu-list">
              ${type === 'skill' ? `<button class="btn btn-sm" data-files="${escHtml(item.name)}">📂 Browse files</button>` : ''}
              <button class="btn btn-sm" data-explain="${escHtml(item.name)}">🤖 Explain with AI</button>
              ${type !== 'command' && !item.external ? `<button class="btn btn-sm" data-improve="${escHtml(item.name)}">✨ Improve with AI</button>` : ''}
              ${!item.external ? `<button class="btn btn-sm more-menu-danger" data-del="${escHtml(item.name)}">🗑 Delete</button>` : ''}
            </div>
          </details>
        </div>
      </div>`;
  }).join('');
  grid.querySelectorAll('[data-run]').forEach(b => {
    b.onclick = () => openRunModal(type, b.dataset.run);
  });
  grid.querySelectorAll('[data-files]').forEach(b => {
    b.onclick = () => openFileExplorer('skills/' + b.dataset.files, '📂 ' + b.dataset.files + ' — skill files');
  });
  grid.querySelectorAll('[data-explain]').forEach(b => {
    b.onclick = () => {
      const it = items.find(x => x.name === b.dataset.explain);
      if (!it) return;
      const meta = {};
      if (it.trigger) meta.scope = it.trigger;
      if (it.model)   meta.scope = (meta.scope ? meta.scope + ' · ' : '') + it.model;
      showExplainer(b.dataset.explain, it.content || it.description || '', type, meta);
    };
  });
  grid.querySelectorAll('[data-improve]').forEach(b => {
    b.onclick = () => {
      const it = items.find(x => x.name === b.dataset.improve);
      if (!it) return;
      const apiPath = type === 'skill' ? 'skills' : type === 'agent' ? 'agents' : 'commands';
      openImproveModal(it.name, type, it.content || '', async (newContent) => {
        await api('PUT', `/${apiPath}/${encodeURIComponent(it.name)}`, { content: newContent });
        // Refresh the section
        if (type === 'skill') loadSkills();
        else if (type === 'agent') loadAgents();
        else loadCommands();
      });
    };
  });
  grid.querySelectorAll('[data-edit]').forEach(b => {
    b.onclick = () => b.dataset.editPath ? openFileEditor(b.dataset.editPath) : onEdit(b.dataset.edit);
  });
  grid.querySelectorAll('[data-del]').forEach(b  => { b.onclick = () => onDelete(b.dataset.del); });
}

// ===== PLUGINS =====

// Tab switching
(function() {
  document.querySelectorAll('.plugin-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.plugin-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const isMarketplace = tab.dataset.tab === 'marketplace';
      document.getElementById('plugins-installed-panel').style.display  = isMarketplace ? 'none' : '';
      document.getElementById('plugins-marketplace-panel').style.display = isMarketplace ? '' : 'none';
      document.getElementById('check-updates-btn').style.display         = isMarketplace ? 'none' : '';
      if (isMarketplace) loadMarketplace();
    };
  });
})();

async function loadPlugins() {
  const plugins = await api('GET', '/plugins');
  const tbody   = document.getElementById('plugins-tbody');

  // Summary counts — how many of each kind is installed
  const claudePlugins = plugins.filter(p => !p.isMcpServer);
  const mcpServers    = plugins.filter(p => p.isMcpServer);
  const enabledCount  = claudePlugins.filter(p => p.enabled).length;
  const summary = document.getElementById('plugins-summary');
  if (summary) {
    const chip = (label, count, color) =>
      `<span class="badge" style="font-size:12px;padding:5px 12px;background:color-mix(in srgb, ${color} 14%, transparent);color:${color};font-weight:700">${count} ${label}</span>`;
    summary.innerHTML =
      chip('total installed', plugins.length, 'var(--accent)') +
      chip('Claude plugins', claudePlugins.length, 'var(--c-plugin, #ff7ac6)') +
      chip('enabled', enabledCount, 'var(--c-workflow, #7ee2a8)') +
      chip('disabled', claudePlugins.length - enabledCount, 'var(--text-muted)') +
      chip('MCP servers', mcpServers.length, 'var(--c-command, #5ec8f8)');
  }

  if (!plugins.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">No plugins installed. Browse the <button class="link-btn" onclick="document.querySelector(\'[data-tab=marketplace]\').click()">Marketplace</button> to add MCP servers.</td></tr>';
    return;
  }
  const descHtml = p => p.description
    ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;max-width:340px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical" title="${escHtml(p.description)}">${escHtml(p.description)}</div>` : '';

  tbody.innerHTML = plugins.map(p => {
    if (p.isMcpServer) {
      const typeLabel = p.mcpType === 'sse' || p.mcpType === 'http' ? 'SSE/HTTP' : 'stdio';
      return `<tr data-plugin-id="${escHtml(p.id)}">
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-weight:600">${escHtml(p.id)}</span>
            <span class="badge" style="background:rgba(137,220,235,.15);color:#89dceb;font-size:10px">MCP</span>
            ${p.scope === 'local' ? '<span class="badge badge-warning" style="font-size:10px" title="Local scope — only active in one project">local</span>' : ''}
          </div>
          ${descHtml(p)}
        </td>
        <td><span class="badge badge-muted" style="font-size:10px">${escHtml(typeLabel)}</span></td>
        <td colspan="2" style="font-size:12px;color:var(--text-muted)" title="${escHtml(p.configFile || '')}">${escHtml((p.configFile || 'settings.json').split(' ')[0])}</td>
        <td data-update-cell><span style="font-size:12px;color:var(--text-muted)">—</span></td>
        <td>
          <button class="icon-act danger" data-mcp-remove="${escHtml(p.id)}" title="Remove this MCP server from its config file">🗑</button>
        </td>
      </tr>`;
    }
    return `
    <tr data-plugin-id="${escHtml(p.id)}">
      <td>
        <div style="font-weight:600">${escHtml(p.id.split('@')[0])}</div>
        <div style="font-size:11px;color:var(--text-dim)">${escHtml(p.id)}</div>
        ${descHtml(p)}
      </td>
      <td><span class="badge badge-muted" data-version-cell>${escHtml(p.version || '—')}</span></td>
      <td style="font-size:12px;color:var(--text-muted)">${fmtDate(p.installedAt)}</td>
      <td style="font-size:12px;color:var(--text-muted)">${fmtDate(p.lastUpdated)}</td>
      <td data-update-cell><span style="font-size:12px;color:var(--text-muted)">—</span></td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <label class="toggle" title="Enable / disable">
            <input type="checkbox" data-pid="${escHtml(p.id)}" ${p.enabled ? 'checked' : ''}>
            <div class="toggle-track"></div>
            <span class="plugin-status" style="font-size:12px;color:var(--text-muted)">${p.enabled ? 'On' : 'Off'}</span>
          </label>
          <button class="icon-act" data-plugin-update="${escHtml(p.id)}" title="Update (claude plugin update)">↑</button>
          <button class="icon-act" data-plugin-reinstall="${escHtml(p.id)}" title="Reinstall (claude plugin install)">⟳</button>
          <button class="icon-act danger" data-plugin-remove="${escHtml(p.id)}" title="Remove (claude plugin uninstall)">🗑</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-pid]').forEach(cb => {
    cb.onchange = async () => {
      try {
        const r = await api('PUT', '/plugins/' + encodeURIComponent(cb.dataset.pid) + '/toggle', {});
        cb.closest('.toggle').querySelector('.plugin-status').textContent = r.enabled ? 'On' : 'Off';
        toast(`Plugin ${r.enabled ? 'enabled' : 'disabled'}: ` + cb.dataset.pid.split('@')[0]);
      } catch (e) { cb.checked = !cb.checked; toast(e.message, 'error'); }
    };
  });

  const wireAction = (attr, apiSuffix, confirmMsg, doneMsg) => {
    tbody.querySelectorAll(`[${attr}]`).forEach(btn => {
      btn.onclick = async () => {
        const id = btn.getAttribute(attr);
        if (confirmMsg && !await confirmDlg('Confirm', confirmMsg.replace('{id}', id))) return;
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = '…';
        try {
          const r = await api('POST', '/plugins/' + encodeURIComponent(id) + '/' + apiSuffix, {});
          toast(doneMsg.replace('{id}', id.split('@')[0]) + (r.output ? '' : ''));
          loadPlugins();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = orig; }
      };
    });
  };
  wireAction('data-plugin-update',    'update',    null,                                   'Updated: {id}');
  wireAction('data-plugin-reinstall', 'reinstall', null,                                   'Reinstalled: {id}');
  wireAction('data-plugin-remove',    'uninstall', 'Uninstall plugin "{id}"?',             'Removed: {id}');

  tbody.querySelectorAll('[data-mcp-remove]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.mcpRemove;
      if (!await confirmDlg('Remove MCP Server', `Remove "${id}" from its config file? Restart Claude Code to deactivate it.`)) return;
      try {
        const r = await api('DELETE', '/plugins/' + encodeURIComponent(id) + '/mcp');
        toast(`Removed "${id}" from ${r.configFile || 'config'} — restart Claude Code to deactivate`);
        loadPlugins();
      } catch (e) { toast(e.message, 'error'); }
    };
  });

  document.getElementById('badge-plugins').textContent = plugins.length;
}

// ===== ADD MCP SERVER (guided form — no raw JSON needed) =====
let _mcpAddType = 'stdio';

function setMcpAddType(t) {
  _mcpAddType = t;
  document.getElementById('mcpTypeStdio').classList.toggle('active', t === 'stdio');
  document.getElementById('mcpTypeRemote').classList.toggle('active', t === 'remote');
  document.getElementById('mcpStdioFields').style.display  = t === 'stdio' ? '' : 'none';
  document.getElementById('mcpRemoteFields').style.display = t === 'remote' ? '' : 'none';
}
document.getElementById('mcpTypeStdio').onclick  = () => setMcpAddType('stdio');
document.getElementById('mcpTypeRemote').onclick = () => setMcpAddType('remote');

document.getElementById('addMcpBtn').onclick = () => {
  ['mcpName', 'mcpCommand', 'mcpArgs', 'mcpEnv', 'mcpUrl'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  setMcpAddType('stdio');
  document.getElementById('addMcpModal').classList.add('open');
  setTimeout(() => document.getElementById('mcpName').focus(), 60);
};
document.getElementById('addMcpClose').onclick  = () => document.getElementById('addMcpModal').classList.remove('open');
document.getElementById('addMcpCancel').onclick = () => document.getElementById('addMcpModal').classList.remove('open');

document.getElementById('addMcpSave').onclick = async () => {
  const name = document.getElementById('mcpName').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (!name) { toast('Give the server a name', 'error'); document.getElementById('mcpName').focus(); return; }
  const btn = document.getElementById('addMcpSave');
  btn.disabled = true; btn.textContent = 'Adding…';
  try {
    let payload;
    if (_mcpAddType === 'stdio') {
      const command = document.getElementById('mcpCommand').value.trim();
      if (!command) { toast('Command is required for a local server', 'error'); return; }
      const args = document.getElementById('mcpArgs').value.split('\n').map(s => s.trim()).filter(Boolean);
      const env = {};
      document.getElementById('mcpEnv').value.split('\n').map(s => s.trim()).filter(Boolean).forEach(line => {
        const eq = line.indexOf('=');
        if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      });
      payload = { serverId: name, type: 'stdio', command, args, env };
    } else {
      const url = document.getElementById('mcpUrl').value.trim();
      if (!url) { toast('URL is required for a remote server', 'error'); return; }
      try { new URL(url); } catch { toast('That URL doesn\'t look valid', 'error'); return; }
      payload = { serverId: name, type: document.getElementById('mcpRemoteType').value, url };
    }
    const r = await api('POST', '/marketplace/direct-install', payload);
    document.getElementById('addMcpModal').classList.remove('open');
    toast(r.output || `Added "${name}" — restart Claude Code to activate`);
    loadPlugins();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Add Server';
  }
};

// ===== MARKETPLACE =====
let _marketplaceData = [];
let _marketplaceCat  = 'All';
let _marketplaceSrc  = 'all';
let _mktSearchQ      = '';
let _mktSources      = [];

async function loadMarketplace() {
  const grid = document.getElementById('marketplace-grid');
  grid.innerHTML = '<div style="padding:32px;color:var(--text-muted);text-align:center">Loading marketplace…</div>';
  try {
    const qs = '/marketplace/browse?source=' + encodeURIComponent(_marketplaceSrc) + (_mktSearchQ ? '&q=' + encodeURIComponent(_mktSearchQ) : '');
    const { plugins, sources } = await api('GET', qs);
    _marketplaceData = plugins;
    _mktSources = sources;
    renderSourceTabs(sources);
    renderMarketplace();
  } catch (e) {
    grid.innerHTML = `<div style="padding:24px;color:var(--danger)">${escHtml(e.message)}</div>`;
  }
}

function renderSourceTabs(sources) {
  const bar = document.getElementById('mktSourceTabs');
  const allCount = _marketplaceData.length;
  bar.innerHTML = `<button class="mkt-src-tab${_marketplaceSrc === 'all' ? ' active' : ''}" data-src="all">All <span class="mkt-src-count">${allCount}</span></button>`
    + sources.map(s => {
        const cnt = _marketplaceData.filter(p => p.source === s.id).length;
        return `<button class="mkt-src-tab${_marketplaceSrc === s.id ? ' active' : ''}" data-src="${escHtml(s.id)}">${escHtml(s.icon || '')} ${escHtml(s.name)} <span class="mkt-src-count">${cnt}</span></button>`;
      }).join('');
  bar.querySelectorAll('[data-src]').forEach(btn => {
    btn.onclick = () => { _marketplaceSrc = btn.dataset.src; loadMarketplace(); };
  });
}

function renderMarketplace() {
  const grid  = document.getElementById('marketplace-grid');
  let items = _marketplaceCat === 'All' ? _marketplaceData : _marketplaceData.filter(p => p.category === _marketplaceCat);
  if (!items.length) {
    grid.innerHTML = '<div style="padding:32px;color:var(--text-muted);text-align:center">No plugins found. Try a different source, category, or search term.</div>';
    return;
  }
  grid.innerHTML = items.map(p => `
    <div class="mkt-card${p.installed ? ' installed' : ''}" data-mkt-id="${escHtml(p.id)}">
      <div class="mkt-card-top">
        <div style="flex:1;min-width:0">
          <div class="mkt-card-name">${escHtml(p.name)}</div>
          <div class="mkt-card-badges">
            <span class="mkt-badge ${p.official ? 'mkt-badge-official' : 'mkt-badge-community'}">${escHtml(p.official ? '✓ Official' : (p.author || 'Community'))}</span>
            <span class="mkt-badge mkt-badge-source" title="${escHtml(p.sourceName || '')}">${escHtml(p.sourceIcon || '📦')} ${escHtml(p.sourceName || p.source || '')}</span>
            <span class="mkt-badge mkt-badge-category">${escHtml(p.category)}</span>
            ${p.installed ? '<span class="mkt-badge mkt-badge-installed">✓ Added</span>' : ''}
          </div>
        </div>
      </div>
      <div class="mkt-card-desc">${escHtml(p.description)}</div>
      <div class="mkt-card-footer">
        <span class="mkt-card-pkg" title="${escHtml(p.package || '')}">${escHtml(p.package || '')}</span>
        ${p.installed
          ? '<span class="btn btn-xs btn-secondary" style="cursor:default;opacity:.6">Added</span>'
          : `<button class="btn btn-xs btn-primary" data-mkt-install="${escHtml(p.id)}">+ Install</button>`}
      </div>
    </div>`).join('');
  grid.querySelectorAll('[data-mkt-install]').forEach(btn => {
    btn.onclick = () => {
      const plugin = _marketplaceData.find(p => p.id === btn.dataset.mktInstall);
      if (plugin) openInstallModal(plugin);
    };
  });
}

// ===== MARKETPLACE SOURCES PANEL =====
document.getElementById('mktSourcesBtn').onclick = toggleSourcesPanel;

document.getElementById('mktAddSourceBtn').onclick = () => {
  document.getElementById('addSourceName').value = '';
  document.getElementById('addSourceUrl').value  = '';
  document.getElementById('addSourceIcon').value = '';
  document.getElementById('addSourceError').style.display = 'none';
  document.getElementById('addSourceModal').classList.add('open');
};
document.getElementById('addSourceClose').onclick  = () => document.getElementById('addSourceModal').classList.remove('open');
document.getElementById('addSourceCancel').onclick = () => document.getElementById('addSourceModal').classList.remove('open');
document.getElementById('addSourceConfirm').onclick = async () => {
  const name  = document.getElementById('addSourceName').value.trim();
  const url   = document.getElementById('addSourceUrl').value.trim();
  const icon  = document.getElementById('addSourceIcon').value.trim();
  const errEl = document.getElementById('addSourceError');
  errEl.style.display = 'none';
  if (!name || !url) { errEl.textContent = 'Name and URL are required.'; errEl.style.display = ''; return; }
  try { new URL(url); } catch { errEl.textContent = 'Invalid URL.'; errEl.style.display = ''; return; }
  const btn = document.getElementById('addSourceConfirm');
  btn.textContent = 'Adding…'; btn.disabled = true;
  try {
    await api('POST', '/marketplace/sources', { name, url, icon });
    document.getElementById('addSourceModal').classList.remove('open');
    toast('Source added: ' + name);
    renderSourcesPanel();
    loadMarketplace();
  } catch (e) { errEl.textContent = e.message; errEl.style.display = ''; }
  finally { btn.textContent = 'Add Source'; btn.disabled = false; }
};

function toggleSourcesPanel() {
  const panel = document.getElementById('mktSourcesPanel');
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? '' : 'none';
  document.getElementById('mktSourcesBtn').textContent = opening ? '✕ Sources' : '⚙ Sources';
  if (opening) renderSourcesPanel();
}

async function renderSourcesPanel() {
  const list = document.getElementById('mktSourcesList');
  list.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:12px">Loading…</div>';
  const sources = await api('GET', '/marketplace/sources');
  _mktSources = sources;
  if (!sources.length) { list.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:12px">No sources.</div>'; return; }
  list.innerHTML = sources.map(s => `
    <div class="mkt-source-row" data-sid="${escHtml(s.id)}">
      <span class="mkt-source-icon">${escHtml(s.icon || '🌐')}</span>
      <div class="mkt-source-info">
        <div class="mkt-source-name">${escHtml(s.name)}</div>
        ${s.url ? `<div class="mkt-source-url">${escHtml(s.url)}</div>` : ''}
      </div>
      <span class="badge ${s.type === 'builtin' ? 'badge-muted' : s.type === 'npm' ? 'badge-accent' : 'badge-success'}" style="font-size:10px">${s.type}</span>
      ${s.type !== 'builtin' ? `
        <label class="toggle" style="margin-left:4px;flex-shrink:0">
          <input type="checkbox" data-src-toggle="${escHtml(s.id)}" ${s.enabled ? 'checked' : ''}>
          <div class="toggle-track"></div>
        </label>
        ${s.type === 'custom' ? `<button class="btn btn-xs btn-danger" data-src-del="${escHtml(s.id)}">✕</button>` : ''}
      ` : '<span style="font-size:11px;color:var(--text-dim);margin-left:8px">Always on</span>'}
    </div>`).join('');
  list.querySelectorAll('[data-src-toggle]').forEach(cb => {
    cb.onchange = async () => {
      await api('PUT', '/marketplace/sources/' + encodeURIComponent(cb.dataset.srcToggle) + '/toggle', {});
      toast((cb.checked ? 'Enabled' : 'Disabled') + ' source');
      loadMarketplace();
    };
  });
  list.querySelectorAll('[data-src-del]').forEach(btn => {
    btn.onclick = async () => {
      if (!await confirmDlg('Remove Source', 'Remove this marketplace source? Plugins already installed from it stay in place.')) return;
      await api('DELETE', '/marketplace/sources/' + encodeURIComponent(btn.dataset.srcDel));
      toast('Source removed');
      renderSourcesPanel();
      loadMarketplace();
    };
  });
}

// Search — debounced
let _mktSearchTimer = null;
document.getElementById('mktSearch').oninput = e => {
  clearTimeout(_mktSearchTimer);
  _mktSearchTimer = setTimeout(() => { _mktSearchQ = e.target.value.trim(); loadMarketplace(); }, 350);
};

// Category filters
document.querySelectorAll('.mkt-cat').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.mkt-cat').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _marketplaceCat = btn.dataset.cat;
    renderMarketplace();
  };
});

// Install modal
let _installModalPlugin = null;
let _installModalDone   = false; // true after a successful install — "Done" then closes the modal
function openInstallModal(plugin) {
  _installModalPlugin = plugin;
  _installModalDone   = false;
  const cmd = (plugin.installCmd || '').trim();
  // Runnable from the app: `claude mcp add`, `claude plugin install`,
  // `claude plugin marketplace add` — including &&-chained combinations.
  const isMcpAdd = cmd.split('&&').map(s => s.trim()).filter(Boolean)
    .every(seg => /^claude (mcp add|plugin install|plugin marketplace add) /.test(seg)) && !!cmd;
  const hasMcpConfig = !!(plugin.mcpCommand || plugin.mcpUrl);

  document.getElementById('installModalTitle').textContent = `Install: ${plugin.name}`;
  document.getElementById('installModalDesc').textContent  = plugin.description || '';
  document.getElementById('installModalCmd').value         = plugin.installCmd || '';
  document.getElementById('installModalOutput').style.display = 'none';
  document.getElementById('installModalOutputPre').textContent = '';
  document.getElementById('installModalConfirm').textContent   = 'Run Install';
  document.getElementById('installModalConfirm').disabled      = false;

  // Show/hide elements based on command type
  const noticeEl  = document.getElementById('installModalNotice');
  const confirmBtn = document.getElementById('installModalConfirm');
  const directBtn  = document.getElementById('installModalDirectBtn');

  if (!plugin.installCmd) {
    noticeEl.textContent = 'No install command available for this plugin. Use "Write to settings.json" if the plugin provided its config, or configure manually.';
    noticeEl.style.display = '';
    confirmBtn.style.display = 'none';
  } else if (!isMcpAdd) {
    const tool = plugin.installCmd.trim().split(' ')[0];
    noticeEl.innerHTML = `⚠ This plugin uses <code style="background:rgba(0,0,0,.2);padding:1px 5px;border-radius:3px">${escHtml(tool)}</code> which may not be installed. You can:<br>• Copy the command and run it in your terminal<br>• Or click <strong>Write to settings.json</strong> if the plugin works via direct MCP config`;
    noticeEl.style.display = '';
    confirmBtn.style.display = hasMcpConfig ? 'none' : '';
  } else {
    noticeEl.style.display = 'none';
    confirmBtn.style.display = '';
  }

  directBtn.style.display = hasMcpConfig ? '' : 'none';

  document.getElementById('installModal').classList.add('open');
  document.getElementById('installModalCmd').focus();
}

function _markInstallDone(plugin, output) {
  const outEl = document.getElementById('installModalOutputPre');
  outEl.textContent = output || 'Installed successfully.';
  outEl.style.color = 'var(--success)';
  document.getElementById('installModalOutput').style.display = '';
  toast(`${plugin.name} added — restart Claude Code to activate`, 'success');
  const card = document.querySelector(`.mkt-card[data-mkt-id="${CSS.escape(plugin.id)}"]`);
  if (card) {
    card.classList.add('installed');
    const ib = card.querySelector('[data-mkt-install]');
    if (ib) ib.outerHTML = '<span class="btn btn-xs btn-secondary" style="cursor:default;opacity:.6">Added</span>';
    const badges = card.querySelector('.mkt-card-badges');
    if (badges && !badges.querySelector('.mkt-badge-installed'))
      badges.insertAdjacentHTML('beforeend', '<span class="mkt-badge mkt-badge-installed">✓ Added</span>');
  }
  const p = _marketplaceData?.find(p => p.id === plugin.id);
  if (p) p.installed = true;
  _installModalDone = true;
  const confirmBtn = document.getElementById('installModalConfirm');
  confirmBtn.textContent = '✓ Done — Close';
  confirmBtn.disabled = false;
  confirmBtn.style.display = '';
  // Refresh the Installed Plugins tab so the new plugin/MCP server shows up
  try { loadPlugins(); } catch {}
}

document.getElementById('installModalClose').onclick  = () => document.getElementById('installModal').classList.remove('open');
document.getElementById('installModalCancel').onclick = () => document.getElementById('installModal').classList.remove('open');
document.getElementById('installModalCopy').onclick = () => {
  navigator.clipboard.writeText(document.getElementById('installModalCmd').value).then(() => toast('Command copied to clipboard'));
};

document.getElementById('installModalDirectBtn').onclick = async () => {
  if (!_installModalPlugin) return;
  const p = _installModalPlugin;
  const btn = document.getElementById('installModalDirectBtn');
  btn.textContent = 'Writing…'; btn.disabled = true;
  try {
    const r = await api('POST', '/marketplace/direct-install', {
      serverId: p.mcpServerId || p.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      type:     p.mcpType || 'stdio',
      command:  p.mcpCommand || '',
      args:     p.mcpArgs || [],
      env:      p.mcpEnv || {},
      url:      p.mcpUrl || '',
    });
    _markInstallDone(p, r.output);
  } catch (e) {
    const outEl = document.getElementById('installModalOutputPre');
    outEl.textContent = e.message;
    outEl.style.color = 'var(--danger)';
    document.getElementById('installModalOutput').style.display = '';
    toast('Write failed: ' + e.message, 'error');
  } finally {
    btn.textContent = '✍ Write to settings.json'; btn.disabled = false;
  }
};

document.getElementById('installModalConfirm').onclick = async () => {
  if (!_installModalPlugin) return;
  // After a successful install the button becomes "Done" — clicking it closes
  // the modal instead of re-running the install (which caused an install loop).
  if (_installModalDone) {
    document.getElementById('installModal').classList.remove('open');
    _installModalDone = false;
    return;
  }
  const command = document.getElementById('installModalCmd').value.trim();
  if (!command) return;
  const btn = document.getElementById('installModalConfirm');
  btn.textContent = 'Installing…'; btn.disabled = true;
  document.getElementById('installModalOutput').style.display = 'none';
  try {
    const r = await api('POST', '/marketplace/' + encodeURIComponent(_installModalPlugin.id) + '/install', { command });
    _markInstallDone(_installModalPlugin, r.output);
  } catch (e) {
    const outEl = document.getElementById('installModalOutputPre');
    outEl.textContent = e.message;
    outEl.style.color = 'var(--danger)';
    document.getElementById('installModalOutput').style.display = '';
    btn.textContent = 'Run Install'; btn.disabled = false;
    toast('Install failed: ' + e.message, 'error');
  }
};

async function checkPluginUpdates() {
  const btn = document.getElementById('check-updates-btn');
  btn.textContent = 'Checking…';
  btn.disabled = true;
  try {
    const results = await api('GET', '/plugins/check-updates');
    const tbody = document.getElementById('plugins-tbody');
    let updatesFound = 0;
    Object.entries(results).forEach(([id, info]) => {
      const row = tbody.querySelector(`tr[data-plugin-id="${CSS.escape(id)}"]`);
      if (!row) return;
      const cell = row.querySelector('[data-update-cell]');
      if (info.hasUpdate) {
        updatesFound++;
        cell.innerHTML = `
          <div style="display:flex;align-items:center;gap:6px">
            <span class="badge badge-update">${escHtml(info.latest)}</span>
            <button class="btn btn-xs btn-primary" data-update-pid="${escHtml(id)}">Update</button>
          </div>`;
        cell.querySelector('[data-update-pid]').onclick = () => updatePlugin(id, info.latest);
      } else if (info.latest) {
        cell.innerHTML = `<span class="badge badge-success" style="font-size:11px">Up to date</span>`;
      } else {
        cell.innerHTML = `<span style="font-size:12px;color:var(--text-muted)">N/A</span>`;
      }
    });
    toast(updatesFound ? `${updatesFound} update${updatesFound > 1 ? 's' : ''} available` : 'All plugins up to date');
  } catch (e) {
    toast('Failed to check updates: ' + e.message, 'error');
  } finally {
    btn.textContent = 'Check for Updates';
    btn.disabled = false;
  }
}

async function updatePlugin(id, latestVersion) {
  const row = document.getElementById('plugins-tbody').querySelector(`tr[data-plugin-id="${CSS.escape(id)}"]`);
  const btn = row && row.querySelector('[data-update-pid]');
  if (btn) { btn.textContent = 'Updating…'; btn.disabled = true; }
  try {
    await api('POST', '/plugins/' + encodeURIComponent(id) + '/update', {});
    toast(`Updated ${id.split('@')[0]} to ${latestVersion}`);
    if (row) {
      row.querySelector('[data-version-cell]').textContent = latestVersion;
      row.querySelector('[data-update-cell]').innerHTML = `<span class="badge badge-success" style="font-size:11px">Up to date</span>`;
    }
  } catch (e) {
    toast('Update failed: ' + e.message, 'error');
    if (btn) { btn.textContent = 'Update'; btn.disabled = false; }
  }
}

// ===== KEYBINDINGS =====
let keybindingsEditor = null;
// Official contexts + common actions (code.claude.com/docs/en/keybindings)
const KB_CATALOG = {
  Global: [
    { a: 'app:interrupt', d: 'Ctrl+C', t: 'Cancel current operation (reserved default)' },
    { a: 'app:toggleTodos', d: 'Ctrl+T', t: "Toggle Claude's to-do checklist" },
    { a: 'app:toggleTranscript', d: 'Ctrl+O', t: 'Toggle verbose transcript' },
    { a: 'app:redraw', d: '—', t: 'Force terminal redraw' },
    { a: 'history:search', d: 'Ctrl+R', t: 'Open history search' },
    { a: 'history:previous', d: 'Up', t: 'Previous history item' },
    { a: 'history:next', d: 'Down', t: 'Next history item' },
  ],
  Chat: [
    { a: 'chat:submit', d: 'Enter', t: 'Submit message' },
    { a: 'chat:newline', d: 'Ctrl+J', t: 'Newline without submitting' },
    { a: 'chat:externalEditor', d: 'Ctrl+G', t: 'Open prompt in external editor' },
    { a: 'chat:cancel', d: 'Escape', t: 'Cancel current input' },
    { a: 'chat:clearInput', d: 'Ctrl+L', t: 'Clear input / redraw' },
    { a: 'chat:cycleMode', d: 'Shift+Tab', t: 'Cycle permission modes' },
    { a: 'chat:modelPicker', d: 'Meta+P', t: 'Open model picker' },
    { a: 'chat:thinkingToggle', d: 'Meta+T', t: 'Toggle extended thinking' },
    { a: 'chat:stash', d: 'Ctrl+S', t: 'Stash current prompt' },
    { a: 'chat:undo', d: 'Ctrl+_', t: 'Undo last action' },
    { a: 'chat:imagePaste', d: 'Ctrl+V', t: 'Paste image from clipboard' },
    { a: 'chat:killAgents', d: 'Ctrl+X Ctrl+K', t: 'Stop all background subagents' },
    { a: 'voice:pushToTalk', d: 'Space', t: 'Voice dictation (when enabled)' },
  ],
  Autocomplete: [
    { a: 'autocomplete:accept', d: 'Tab', t: 'Accept suggestion' },
    { a: 'autocomplete:dismiss', d: 'Escape', t: 'Dismiss menu' },
    { a: 'autocomplete:previous', d: 'Up', t: 'Previous suggestion' },
    { a: 'autocomplete:next', d: 'Down', t: 'Next suggestion' },
  ],
  Confirmation: [
    { a: 'confirm:yes', d: 'Y / Enter', t: 'Confirm action' },
    { a: 'confirm:no', d: 'N / Escape', t: 'Decline action' },
    { a: 'confirm:toggle', d: 'Space', t: 'Toggle selection' },
    { a: 'confirm:cycleMode', d: 'Shift+Tab', t: 'Cycle permission modes' },
    { a: 'confirm:toggleExplanation', d: 'Ctrl+E', t: 'Toggle permission explanation' },
  ],
  Transcript: [
    { a: 'transcript:toggleShowAll', d: 'Ctrl+E', t: 'Toggle show all content' },
    { a: 'transcript:exit', d: 'q / Escape', t: 'Exit transcript view' },
  ],
  HistorySearch: [
    { a: 'historySearch:next', d: 'Ctrl+R', t: 'Next match' },
    { a: 'historySearch:execute', d: 'Enter', t: 'Execute selected command' },
    { a: 'historySearch:cycleScope', d: 'Ctrl+S', t: 'Cycle scope: session/project/everywhere' },
  ],
  Task: [{ a: 'task:background', d: 'Ctrl+B', t: 'Background current task' }],
  Tabs: [
    { a: 'tabs:next', d: 'Tab / Right', t: 'Next tab' },
    { a: 'tabs:previous', d: 'Shift+Tab / Left', t: 'Previous tab' },
  ],
  Select: [
    { a: 'select:next', d: 'Down / J', t: 'Next option' },
    { a: 'select:previous', d: 'Up / K', t: 'Previous option' },
    { a: 'select:accept', d: 'Enter', t: 'Accept selection' },
    { a: 'select:cancel', d: 'Escape', t: 'Cancel' },
  ],
  Scroll: [
    { a: 'scroll:pageUp', d: 'PageUp', t: 'Scroll up half a viewport (fullscreen mode)' },
    { a: 'scroll:pageDown', d: 'PageDown', t: 'Scroll down half a viewport' },
    { a: 'scroll:top', d: 'Ctrl+Home', t: 'Jump to conversation start' },
    { a: 'scroll:bottom', d: 'Ctrl+End', t: 'Jump to latest message' },
    { a: 'selection:copy', d: 'Ctrl+Shift+C', t: 'Copy selected text' },
  ],
  Settings: [{ a: 'settings:search', d: '/', t: 'Enter search mode' }],
  Plugin: [
    { a: 'plugin:toggle', d: 'Space', t: 'Toggle plugin selection' },
    { a: 'plugin:install', d: 'I', t: 'Install selected plugins' },
    { a: 'plugin:favorite', d: 'F', t: 'Favorite selected plugin' },
  ],
  ModelPicker: [
    { a: 'modelPicker:decreaseEffort', d: 'Left', t: 'Decrease effort level' },
    { a: 'modelPicker:increaseEffort', d: 'Right', t: 'Increase effort level' },
  ],
  MessageSelector: [
    { a: 'messageSelector:up', d: 'Up / K', t: 'Move up' },
    { a: 'messageSelector:down', d: 'Down / J', t: 'Move down' },
    { a: 'messageSelector:select', d: 'Enter', t: 'Select message' },
  ],
  DiffDialog: [
    { a: 'diff:dismiss', d: 'Escape', t: 'Close diff viewer' },
    { a: 'diff:nextFile', d: 'Down / J', t: 'Next file' },
    { a: 'diff:previousFile', d: 'Up / K', t: 'Previous file' },
  ],
  Footer: [{ a: 'footer:openSelected', d: 'Enter', t: 'Open selected footer item' }],
  Attachments: [{ a: 'attachments:remove', d: 'Backspace', t: 'Remove selected attachment' }],
  ThemePicker: [{ a: 'theme:toggleSyntaxHighlighting', d: 'Ctrl+T', t: 'Toggle syntax highlighting' }],
  Help: [{ a: 'help:dismiss', d: 'Escape', t: 'Close help menu' }],
};

const KB_SCAFFOLD = {
  $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
  $docs: 'https://code.claude.com/docs/en/keybindings',
  bindings: [
    { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor' } },
  ],
};

function kbParse(content) {
  try {
    const j = JSON.parse(content);
    if (j && Array.isArray(j.bindings)) return j;
  } catch {}
  return null;
}

function kbPopulateForm() {
  const ctxSel = document.getElementById('kbContext');
  if (ctxSel.options.length === 0) {
    ctxSel.innerHTML = Object.keys(KB_CATALOG).map(c => `<option value="${c}">${c}</option>`).join('');
    ctxSel.value = 'Chat';
    ctxSel.onchange = kbPopulateForm;
  }
  const ctx = ctxSel.value;
  document.getElementById('kbActionList').innerHTML =
    (KB_CATALOG[ctx] || []).map(x => `<option value="${x.a}">${x.t} (default: ${x.d})</option>`).join('');
  document.getElementById('kbActionHint').textContent =
    `Actions in ${ctx}: ` + (KB_CATALOG[ctx] || []).map(x => x.a).join(' · ');
}

function kbRenderCurrent(parsed, rawContent) {
  const el = document.getElementById('kb-current');
  // File exists but isn't the official { bindings: [...] } shape (e.g. created
  // by an older tool) — say so explicitly and offer a one-click fix.
  if (rawContent && rawContent.trim() && !parsed) {
    el.innerHTML = `
      <div class="card" style="padding:12px 14px;font-size:12.5px;border-left:3px solid var(--warning)">
        ⚠ <strong>keybindings.json exists but isn't in Claude Code's official format</strong> (an object with a <code>bindings</code> array), so Claude Code ignores it.
        Review it in the raw editor below, or
        <button class="btn btn-primary btn-sm" id="kbConvertBtn" style="margin-left:6px">Replace with a valid starter</button>
      </div>`;
    document.getElementById('kbConvertBtn').onclick = async () => {
      if (!await confirmDlg('Replace keybindings.json', 'Replace it with the official-format starter? The old content will be lost.')) return;
      await api('PUT', '/keybindings', { content: JSON.stringify(KB_SCAFFOLD, null, 2) });
      toast('keybindings.json converted to the official format');
      loadKeybindings();
    };
    return;
  }
  if (!parsed || !parsed.bindings.length || !parsed.bindings.some(b => Object.keys(b.bindings || {}).length)) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:4px 0 8px">No custom bindings yet — Claude Code is using all defaults. Add one below.</div>';
    return;
  }
  const rows = [];
  parsed.bindings.forEach((block, bi) => {
    Object.entries(block.bindings || {}).forEach(([key, action]) => {
      const known = (KB_CATALOG[block.context] || []).find(x => x.a === action);
      rows.push(`<tr>
        <td><span class="badge badge-accent" style="font-size:10px">${escHtml(block.context || '?')}</span></td>
        <td style="font-family:monospace;font-size:12px;font-weight:600">${escHtml(key)}</td>
        <td style="font-family:monospace;font-size:12px">${action === null ? '<span class="badge badge-warning" style="font-size:10px">unbound</span>' : escHtml(action)}</td>
        <td style="font-size:11px;color:var(--text-muted)">${action === null ? 'Default shortcut disabled' : escHtml(known?.t || 'Custom action')}</td>
        <td><button class="icon-act danger" data-kb-del="${bi}::${escHtml(key)}" title="Remove this binding">🗑</button></td>
      </tr>`);
    });
  });
  el.innerHTML = `<div class="card" style="padding:0;overflow:hidden;margin-bottom:4px"><table style="width:100%">
    <thead><tr><th>Context</th><th>Key</th><th>Action</th><th>What it does</th><th></th></tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
  el.querySelectorAll('[data-kb-del]').forEach(b => {
    b.onclick = async () => {
      const [bi, key] = b.dataset.kbDel.split('::');
      delete parsed.bindings[Number(bi)].bindings[key];
      parsed.bindings = parsed.bindings.filter(bl => Object.keys(bl.bindings || {}).length);
      await api('PUT', '/keybindings', { content: JSON.stringify(parsed, null, 2) });
      toast('Binding removed — applies instantly in Claude Code');
      loadKeybindings();
    };
  });
}

async function loadKeybindings() {
  const { content, exists } = await api('GET', '/keybindings');
  document.getElementById('keybindings-info').style.display    = exists ? 'none' : 'flex';
  document.getElementById('keybindingsCreateBtn').style.display = exists ? 'none' : 'inline-flex';
  keybindingsContent = content || JSON.stringify(KB_SCAFFOLD, null, 2);
  kbPopulateForm();
  kbRenderCurrent(exists ? kbParse(content) : null, exists ? content : '');
  if (!keybindingsEditor && monacoReady) keybindingsEditor = createEditor('keybindings-editor-wrap', 'json', keybindingsContent);
  else if (keybindingsEditor) keybindingsEditor.setValue(keybindingsContent);
  else document.getElementById('keybindings-editor-wrap').innerHTML = '<div style="padding:20px;color:var(--text-muted)">Loading editor…</div>';
}

// Populate the context picker immediately at load — never an empty select
kbPopulateForm();

document.getElementById('kbAddBtn').onclick = async () => {
  const context = document.getElementById('kbContext').value;
  const key = document.getElementById('kbKey').value.trim().toLowerCase();
  const unbind = document.getElementById('kbUnbind').checked;
  const action = unbind ? null : document.getElementById('kbAction').value.trim();
  if (!key) { toast('Enter a keystroke (e.g. ctrl+e)', 'error'); return; }
  if (['ctrl+c', 'ctrl+d', 'ctrl+m'].includes(key)) { toast(`${key} is reserved by Claude Code and cannot be rebound`, 'error'); return; }
  if (!unbind && !action) { toast('Pick an action, or check "unbind"', 'error'); return; }
  const { content, exists } = await api('GET', '/keybindings');
  const parsed = (exists && kbParse(content)) || { ...KB_SCAFFOLD, bindings: [] };
  let block = parsed.bindings.find(b => b.context === context);
  if (!block) { block = { context, bindings: {} }; parsed.bindings.push(block); }
  block.bindings = block.bindings || {};
  block.bindings[key] = action;
  try {
    await api('PUT', '/keybindings', { content: JSON.stringify(parsed, null, 2) });
    toast(`${key} → ${action === null ? 'unbound' : action} in ${context} — applies instantly`);
    document.getElementById('kbKey').value = '';
    document.getElementById('kbAction').value = '';
    document.getElementById('kbUnbind').checked = false;
    loadKeybindings();
  } catch (e) { toast(e.message, 'error'); }
};

document.getElementById('keybindingsCreateBtn').onclick = async () => {
  try {
    await api('PUT', '/keybindings', { content: JSON.stringify(KB_SCAFFOLD, null, 2) });
    toast('keybindings.json created with a starter binding (ctrl+e → external editor)');
    loadKeybindings();
  } catch (e) { toast(e.message, 'error'); }
};
document.getElementById('saveKeybindings').onclick = async () => {
  if (!keybindingsEditor) return;
  try { await api('PUT', '/keybindings', { content: keybindingsEditor.getValue() }); toast('Keybindings saved'); }
  catch (e) { toast(e.message, 'error'); }
};

// ===== EDITOR OVERLAY + REFERENCE PANEL =====
let overlayEditor = null;
let overlayInitialContent = '';

function openOverlay(title, content, language, refType, onSave, defaultRefOpen = false) {
  overlayCallback = onSave;
  overlayRefType  = refType;
  overlayInitialContent = content;
  document.getElementById('overlayTitle').textContent = title;
  document.getElementById('editorOverlay').classList.add('open');

  refPanelOpen = defaultRefOpen;
  buildReferencePanel(refType);
  updateRefPanel();

  if (overlayEditor) { overlayEditor.dispose(); overlayEditor = null; }
  requestAnimationFrame(() => {
    overlayEditor = createEditor('overlayEditorWrap', language, content);
    if (overlayEditor && monacoReady) {
      overlayEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        document.getElementById('overlaySave').click();
      });
    }
  });
}

function buildReferencePanel(type) {
  const ref   = FIELD_REF[type];
  const panel = document.getElementById('referencePanel');
  if (!ref) { panel.innerHTML = ''; return; }
  panel.innerHTML = `
    <div class="reference-panel-header">${escHtml(ref.title)}</div>
    ${ref.fields.map(f => `
      <div class="ref-field">
        <div class="ref-field-name">${escHtml(f.name)}<span class="badge ${f.req ? 'badge-accent' : 'badge-muted'}" style="font-size:9px">${f.req ? 'required' : 'optional'}</span></div>
        <div class="ref-field-type">${escHtml(f.type)}</div>
        <div class="ref-field-desc">${escHtml(f.desc)}</div>
        <div class="ref-field-example">${escHtml(f.ex)}</div>
      </div>`).join('')}
    ${ref.note ? `<div class="ref-note">${escHtml(ref.note)}</div>` : ''}`;
}

function updateRefPanel() {
  const panel = document.getElementById('referencePanel');
  const btn   = document.getElementById('overlayRefBtn');
  panel.classList.toggle('collapsed', !refPanelOpen);
  btn.classList.toggle('active', refPanelOpen);
  btn.textContent = refPanelOpen ? '✕ Reference' : '? Reference';
  if (overlayEditor) setTimeout(() => overlayEditor.layout(), 220);
}

document.getElementById('overlayRefBtn').onclick = () => { refPanelOpen = !refPanelOpen; updateRefPanel(); };

function closeOverlay() {
  if (overlayEditor && overlayEditor.getValue() !== overlayInitialContent) {
    if (!window.confirm('Discard unsaved changes?')) return;
  }
  document.getElementById('editorOverlay').classList.remove('open');
  overlayCallback = null;
}
document.getElementById('overlayDiscard').onclick = closeOverlay;
document.getElementById('overlaySave').onclick = async () => {
  if (!overlayEditor || !overlayCallback) return;
  try {
    await overlayCallback(overlayEditor.getValue());
    overlayInitialContent = overlayEditor.getValue(); // mark as saved so discard doesn't warn
    document.getElementById('editorOverlay').classList.remove('open');
    overlayCallback = null;
  } catch (e) { toast(e.message, 'error'); }
};
document.getElementById('editorOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('editorOverlay')) closeOverlay();
});

// ===== PENDING EDITOR INIT (called when Monaco finishes loading) =====
function initPendingEditors() {
  if (currentSection === 'claude-md'    && !claudeMdEditor)    claudeMdEditor    = createEditor('claude-md-editor-wrap',    'markdown', claudeMdContent);
  if (currentSection === 'keybindings' && !keybindingsEditor) keybindingsEditor = createEditor('keybindings-editor-wrap', 'json',     keybindingsContent);
  if (currentSection === 'settings'    && !settingsRawEditor)  settingsRawEditor = createEditor('settings-raw-editor',      'json',     JSON.stringify(settingsData, null, 2));
}

// ===== UTILS =====
function escHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(iso) { try { return iso ? new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—'; } catch { return iso || '—'; } }

window.navigate = navigate;

// ===== EXAMPLES =====
const EXAMPLES = [
  // ──────────── CUSTOM EVENTS ────────────
  {
    id: 'hook-post-commit', type: 'hook-file', name: 'post-commit-detected.mjs', icon: '🧬',
    title: 'PostCommit — a custom event, end to end',
    hookEvent: 'PostToolUse', hookMatcher: 'Bash',
    description: 'Claude Code has no PostCommit event — this derives one: a PostToolUse hook that fires only after a successful `git commit`, then logs the commit hash and message to ~/.claude/commits.jsonl. Shows the full custom-event pattern: detect one condition, exit fast otherwise, fail open.',
    content: `#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// CUSTOM EVENT: PostCommit
//
// WHAT IT IS   Claude Code only fires built-in events (PreToolUse,
//              PostToolUse, Stop…). "PostCommit" is a DERIVED event:
//              this script attaches to PostToolUse (matcher: Bash) and
//              fires ONLY when the Bash command was a successful
//              \`git commit\`. Every other command exits instantly —
//              as far as anyone can tell, the event simply didn't fire.
//
// USAGE        1. Save as ~/.claude/hooks/post-commit-detected.mjs
//                 ("Use This" does this for you)
//              2. Wire it in settings.json under PostToolUse with
//                 matcher "Bash" (the wire dialog opens automatically):
//                 { "PostToolUse": [{ "matcher": "Bash", "hooks":
//                   [{ "type": "command",
//                      "command": "node ~/.claude/hooks/post-commit-detected.mjs" }] }] }
//              3. Done — every git commit Claude makes is now recorded
//                 in ~/.claude/commits.jsonl (one JSON line per commit).
//
// WHY          An audit trail of every commit Claude creates, without
//              asking Claude to remember anything. Swap the log action
//              for a desktop notification, a Slack webhook, or a
//              "redirect Claude to push" — the detection stays the same.
// ═══════════════════════════════════════════════════════════════
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const rl = createInterface({ input: process.stdin, terminal: false });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  try {
    const input = JSON.parse(lines.join('\\n') || '{}');

    // ── DETECTION: is this our event? ──
    // Only Bash tool results…
    if (input.tool_name !== 'Bash') process.exit(0);
    const cmd = input.tool_input?.command || '';
    // …that ran git commit…
    if (!/\\bgit\\s+commit\\b/.test(cmd)) process.exit(0);
    // …and succeeded (a failed commit is NOT a PostCommit event).
    const out = String(input.tool_response?.stdout ?? input.tool_response ?? '');
    if (/error|fatal:/i.test(out)) process.exit(0);

    // ── THE EVENT FIRED: perform the action ──
    let hash = '', message = '';
    try {
      hash    = execSync('git rev-parse --short HEAD', { timeout: 3000 }).toString().trim();
      message = execSync('git log -1 --pretty=%s',     { timeout: 3000 }).toString().trim();
    } catch {}
    appendFileSync(join(homedir(), '.claude', 'commits.jsonl'), JSON.stringify({
      event: 'PostCommit', at: new Date().toISOString(), hash, message, command: cmd.slice(0, 200),
    }) + '\\n');

    // Feedback-only output (never blocks anything)
    process.stdout.write(JSON.stringify({ continue: true, reason: \`[PostCommit] recorded \${hash} — \${message}\` }));
    process.exit(0);
  } catch {
    process.exit(0); // FAIL-OPEN: a broken audit log must never block Claude
  }
});
`,
  },
  // ──────────── SKILLS ────────────
  {
    id: 'skill-git-standup', type: 'skill', name: 'git-standup', icon: '📅',
    title: 'Daily Git Standup',
    description: 'Analyzes recent git commits and writes your daily standup update automatically.',
    content: `---
# name: identifies this skill. Used as the slash command trigger: /git-standup
name: git-standup

# description: Claude reads this to understand what the skill does.
# ">" (folded scalar) lets you write multi-line text that collapses to one paragraph.
description: >
  Analyzes recent git commits and generates a concise daily standup update.
  Shows what was done yesterday and today, grouped by meaningful themes.

# when_to_use: the most important field — Claude uses this to auto-activate
# the skill without the user explicitly naming it. List real trigger phrases.
when_to_use: >
  Use when the user asks for a standup update, daily summary, what they worked on,
  or needs to write a status update for their team. Trigger phrases: "standup",
  "what did I work on", "daily update", "status update".

# argument-hint: shown as placeholder text when the user types /git-standup [here]
argument-hint: "[days to look back, default: 1]"
---

# Daily Git Standup Helper

Generate a concise standup update from recent git activity.

## Steps (always follow this order)

1. **Confirm we're in a git repo**
   Run: git rev-parse --show-toplevel
   If this fails, ask the user which project they want to report on.

2. **Get commits from the last 2 days** (covers "yesterday" and "today")
   Run: git log --format="%ad | %s" --date=short --since="2 days ago"
   The --format gives us the date and subject line so we can group by day.

3. **Separate into yesterday vs today buckets**
   Use today's and yesterday's date strings to classify each commit line.
   Skip merge commits (they start with "Merge branch" or "Merge pull request").

4. **Distill raw commit messages into plain English**
   - "feat: login-page-v2-final" → "Added login page"
   - Multiple commits on the same feature → one combined bullet
   - WIP/temp commits → note as "Continued work on X"

5. **Format the output exactly like this:**
   Yesterday:
   • [what was accomplished]

   Today (so far):
   • [what has been done, or "planning to: ..."]

   Blockers:
   • None  (or describe any blockers honestly)

Keep the entire standup to 4-6 bullets.
If today is Monday, "yesterday" means the previous Friday — skip the weekend.`
  },
  {
    id: 'skill-code-reviewer', type: 'skill', name: 'code-reviewer', icon: '🔍',
    title: 'Structured Code Reviewer',
    description: 'Systematic code review covering correctness, security, performance, and readability — severity-tagged.',
    content: `---
# name: also used as the slash command: /code-reviewer
name: code-reviewer

description: >
  Performs a thorough, structured code review covering correctness, security,
  performance, readability, and test coverage. Returns findings organized by
  severity so the most critical issues are always addressed first.

# when_to_use: be specific — list real phrases that should trigger this skill
when_to_use: >
  Use when the user asks to review code, audit a file, check a PR, look for bugs,
  or improve code quality. Works on any language. Trigger phrases: "review this",
  "check this code", "any issues with", "is this safe to merge", "audit".

argument-hint: "[file path or paste code directly]"
---

# Structured Code Reviewer

A review that covers every angle a senior engineer checks on every PR.

## Review order (always follow this sequence — most critical first)

### 1. Correctness
- Does the code actually do what it claims?
- Edge cases: empty input, null/undefined, zero, negative numbers, max values
- Are all error paths handled? Do they clean up resources (files, DB connections)?
- Async code: are all awaits present? Any race conditions or unhandled rejections?

### 2. Security (OWASP Top 10 focus)
- Injection — are SQL/shell/LDAP queries parameterized or escaped?
- XSS — is user input sanitized before rendering in HTML?
- Path traversal — are file paths validated against a safe root directory?
- Secrets — are credentials or API tokens hardcoded anywhere?
- Auth — are endpoints checking authorization (not just authentication)?
- Sensitive data — is PII or passwords logged or returned in API responses?

### 3. Performance
- Queries inside loops (N+1 pattern) — can they be batched into one query?
- Large data loaded into memory — should it be streamed instead?
- Unnecessary recomputation inside loops — cache or memoize results?

### 4. Readability
- Names that explain intent? (avoid: data, tmp, x, result)
- Functions longer than ~40 lines — extract helpers with clear names
- Nesting deeper than 3 levels — use early returns to flatten
- Comments should explain WHY, not WHAT the code does

### 5. Tests
- Happy path covered? Edge cases covered? Error cases covered?
- External deps (DB, HTTP APIs) properly mocked in unit tests?

## Output format

Organize every finding into one of these buckets:
🔴 Critical — fix before merging (crashes, data loss, security holes)
🟠 Major    — should fix (bugs, missing error handling, slow performance)
🟡 Minor    — nice to fix (readability, naming, small inefficiencies)
💡 Suggestion — optional improvement (better pattern, refactor idea)

For every finding: location → what the problem is → why it matters → concrete fix.
End with a one-line verdict: "Ready to merge" / "Fix the 2 critical issues first".`
  },

  // ──────────── AGENTS ────────────
  {
    id: 'agent-researcher', type: 'agent', name: 'researcher', icon: '🔎',
    title: 'Read-Only Research Agent',
    description: 'A safe, read-only agent for exploring codebases and answering questions — never touches files.',
    content: `---
# name: how Claude identifies and spawns this agent.
# Used in Task() calls: Task("find the auth logic", agent="researcher")
name: researcher

# description: CRITICAL — Claude reads this to decide which agent to use.
# Include keywords that users and Claude would naturally say.
# Be explicit about what it WON'T do (builds trust for autonomous use).
description: >
  A read-only research agent that searches codebases, reads documentation,
  and answers technical questions without modifying any files. Safe to run
  on any codebase including production. Use for investigation and fact-finding.

# model: which Claude model powers this agent.
# claude-haiku-4-5-20251001 — fastest and cheapest. Great for lookup tasks.
# claude-sonnet-4-6         — balanced. Good default for most tasks.
# claude-opus-4-7           — most capable. Use for deep reasoning tasks.
model: claude-haiku-4-5-20251001

# tools: explicitly list allowed tools. Omit to inherit all parent tools.
# Restricting to read-only tools makes this agent safe to run autonomously.
tools:
  - Read   # reads file contents by path
  - Bash   # for grep, find, git log — read-only shell commands
  - Grep   # fast symbol and pattern search across the codebase

# disallowedTools: belt-and-suspenders — even if tools list changes, these stay blocked.
disallowedTools:
  - Edit      # cannot modify existing files
  - Write     # cannot create new files
  - WebSearch # keeps focus on the local codebase

# maxTurns: caps how many steps the agent can take before stopping.
# 20 is enough for: understand structure → search → read context → synthesize answer
maxTurns: 20

# permissionMode: "acceptEdits" lets it run tool calls without prompting you each time.
# Safe here because all tools are read-only.
permissionMode: acceptEdits
---

# Read-Only Research Agent

I explore and explain — I never modify files.

## My approach

1. Start broad — understand the directory structure before diving into files
2. Search strategically — grep for symbols/patterns, then read surrounding context
3. Follow the thread — trace imports, function calls, and references across files
4. Cite sources — every finding includes a file:line reference you can verify
5. Synthesize, don't dump — give a structured answer, not a raw file listing

## What to ask me

- "Where is the authentication logic?"
- "How does the payment flow work end to end?"
- "Find all callers of processOrder() and explain what each does"
- "Is there test coverage for the login feature?"
- "What does this module do and what depends on it?"`
  },
  {
    id: 'agent-test-runner', type: 'agent', name: 'test-runner', icon: '🧪',
    title: 'Isolated Test Runner',
    description: 'Runs your test suite in a separate git worktree — side-effects never touch your working copy.',
    content: `---
name: test-runner

description: >
  Runs the test suite in an isolated git worktree so test artifacts, coverage
  reports, and database side-effects never touch the main working tree.
  Reports results with pass/fail counts and highlights failing tests with
  their error output and likely causes.

# claude-sonnet-4-6 balances speed and reasoning ability.
# Needed here because the agent has to understand error output and suggest fixes.
model: claude-sonnet-4-6

tools:
  - Bash   # to install deps, run test commands, and capture output
  - Read   # to read test files and understand what each test expects

# isolation: "worktree" creates a temporary git worktree — a clean copy of the repo.
# All changes the agent makes are DISCARDED when it finishes.
# Essential for tests that write files, seed databases, or mutate global state.
isolation: worktree

# maxTurns: 30 gives headroom for:
# detect runner → install deps → run tests → read failures → investigate → report
maxTurns: 30

permissionMode: acceptEdits
---

# Isolated Test Runner

I run your tests in a clean worktree so nothing in your working copy is disturbed.

## Steps

1. **Detect the test runner** by looking for:
   - package.json → npm test / npx jest / npx vitest
   - pytest.ini or pyproject.toml → pytest
   - Makefile with test target → make test
   - go.mod → go test ./...
   - Cargo.toml → cargo test

2. **Install dependencies** if node_modules / .venv / vendor dirs are missing.

3. **Run the full suite** and capture all output (stdout + stderr together).

4. **Parse and report results**:
   Results: 142 passed · 3 failed · 2 skipped

   FAILED: auth/login.test.ts — "returns 401 for invalid token"
     Expected: 401  |  Received: 500
     at src/auth/middleware.ts:47
     Likely cause: middleware throws unhandled error instead of returning 401

5. **Suggest fixes** for each failure — common patterns to check:
   missing mocks, wrong assertions, env vars not set, DB not seeded.`
  },

  // ──────────── HOOKS ────────────
  {
    id: 'hook-audit-logger', type: 'hook-file', name: 'audit-logger.mjs', icon: '📋',
    title: 'Audit Logger',
    description: 'Logs every tool call with timestamp to a daily log file — great for compliance or debugging.',
    hookEvent: 'PreToolUse', hookMatcher: '',
    content: `#!/usr/bin/env node
// audit-logger.mjs — log every tool call Claude makes to a timestamped file.
//
// REGISTER IN settings.json:
// "PreToolUse": [{
//   "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/audit-logger.mjs" }]
// }]
//
// FIRES: before every tool call (PreToolUse event)
// EFFECT: appends a compact log line to ~/.claude/logs/audit-YYYY-MM-DD.log
// OUTPUT: { "continue": true } — always allows the tool call to proceed

import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// One log file per day — auto-rotates at midnight, easy to grep
const LOG_DIR  = join(homedir(), '.claude', 'logs');
const today    = new Date().toISOString().slice(0, 10); // "2026-07-22"
const LOG_FILE = join(LOG_DIR, \`audit-\${today}.log\`);

// Claude Code sends hook data as JSON on stdin.
// Collect all lines first — stdin can arrive in multiple chunks.
const rl    = createInterface({ input: process.stdin, terminal: false });
const lines = [];
rl.on('line', line => lines.push(line));

rl.on('close', () => {
  try {
    const input = JSON.parse(lines.join('\\n') || '{}');

    // Fields Claude Code sends for PreToolUse:
    //   tool_name  — e.g. "Edit", "Bash", "Read", "mcp__server__tool"
    //   tool_input — object containing the arguments passed to the tool
    //   session_id — unique ID for the current Claude Code session
    const { tool_name, tool_input, session_id } = input;

    // Build a compact, grep-friendly one-liner
    const ts           = new Date().toISOString();
    const sid          = (session_id || 'unknown').slice(0, 8); // 8 chars is enough to identify a session
    const inputSummary = JSON.stringify(tool_input || {}).slice(0, 200); // truncate long inputs
    const logLine      = \`\${ts} [\${sid}] \${tool_name} \${inputSummary}\\n\`;

    mkdirSync(LOG_DIR, { recursive: true }); // create dir on first run
    appendFileSync(LOG_FILE, logLine);

  } catch {
    // IMPORTANT: never let a hook error stop Claude from working.
    // Swallow all errors silently — logging is non-critical.
  }

  // { "continue": true } → allow the tool call to proceed.
  // Omitting this also works, but being explicit makes intent clear.
  // { "continue": false } → would BLOCK the tool call — don't use that here.
  process.stdout.write(JSON.stringify({ continue: true }));
});`
  },
  {
    id: 'hook-block-dangerous', type: 'hook-file', name: 'block-dangerous.mjs', icon: '🛡️',
    title: 'Dangerous Command Blocker',
    description: 'Blocks Bash commands matching dangerous patterns before Claude executes them.',
    hookEvent: 'PreToolUse', hookMatcher: 'Bash',
    content: `#!/usr/bin/env node
// block-dangerous.mjs — block dangerous shell commands before Claude runs them.
//
// REGISTER with a "Bash" matcher so it ONLY fires for Bash tool calls:
// "PreToolUse": [{
//   "matcher": "Bash",
//   "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/block-dangerous.mjs" }]
// }]
//
// The matcher="Bash" means this hook is skipped for Edit, Read, etc.
// Only shell commands are checked — much more efficient than running on every tool.

import { createInterface } from 'node:readline';

// Each entry: a regex tested against the shell command, and a human-readable reason.
// The reason is shown to the user when a command is blocked.
// Add your own patterns to fit your security requirements.
const BLOCKED = [
  // Deleting the entire filesystem or home directory — catastrophic and irreversible
  { re: /rm\\s+-rf?\\s+\\/(?:\\s|$)/,     why: 'rm -rf / would delete the entire filesystem' },
  { re: /rm\\s+-rf?\\s+~(?:\\/|\\s|$)/,   why: 'rm -rf ~ would delete your entire home directory' },

  // Piping remote scripts into a shell — supply-chain attack risk
  // An attacker could serve malicious content from the URL being piped
  { re: /curl[^|]*\\|\\s*(ba)?sh/,        why: 'curl | bash executes untrusted remote code' },
  { re: /wget[^|]*\\|\\s*(ba)?sh/,        why: 'wget | bash executes untrusted remote code' },

  // Overwriting system config files — can break the OS
  { re: />\\s*\\/etc\\//,                  why: 'Overwriting /etc/ files can break system configuration' },

  // Fork bomb — exhausts all processes until the machine hangs
  { re: /:\\(\\)\\s*\\{.*\\};\\s*:/,       why: 'Fork bomb pattern — would hang the machine' },

  // Writing directly to disk devices — immediate data loss
  { re: /dd\\s+if=.*of=\\/dev\\/(s|h|nv)/, why: 'Writing directly to a disk device destroys data' },
];

const rl    = createInterface({ input: process.stdin, terminal: false });
const lines = [];
rl.on('line', line => lines.push(line));

rl.on('close', () => {
  try {
    const input   = JSON.parse(lines.join('\\n') || '{}');
    // For Bash tool calls, the shell command string is in tool_input.command
    const command = (input.tool_input?.command || '').trim();

    const hit = BLOCKED.find(({ re }) => re.test(command));
    if (hit) {
      // BLOCK the command. Claude Code shows stopReason to the user.
      process.stdout.write(JSON.stringify({
        continue:   false,
        stopReason: \`Safety hook blocked: \${hit.why}\\nCommand: \${command.slice(0, 150)}\`
      }));
      return;
    }
  } catch {
    // On parse error, ALLOW the command (fail open).
    // Failing closed would silently break legitimate work — fail open is safer here.
  }

  // Command looks safe — allow it to proceed
  process.stdout.write(JSON.stringify({ continue: true }));
});`
  },
  {
    id: 'hook-notify-done', type: 'hook-file', name: 'notify-done.mjs', icon: '🔔',
    title: 'Task Complete Notifier',
    description: 'Sends a native desktop notification when Claude finishes — works on macOS, Linux, and Windows.',
    hookEvent: 'Stop', hookMatcher: '',
    content: `#!/usr/bin/env node
// notify-done.mjs — send a desktop notification when Claude finishes a task.
//
// REGISTER on the Stop event (fires after Claude's final message in a turn):
// "Stop": [{
//   "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/notify-done.mjs" }]
// }]
//
// FIRES: when Claude stops responding (task complete, max turns, or error)
// EFFECT: native OS notification — no npm packages required
// OUTPUT: Stop hooks don't need a response — just exit cleanly

import { createInterface } from 'node:readline';
import { exec }            from 'node:child_process';
import { platform }        from 'node:os';

const rl    = createInterface({ input: process.stdin, terminal: false });
const lines = [];
rl.on('line', line => lines.push(line));

rl.on('close', () => {
  let message = 'Task complete ✓';

  try {
    const input = JSON.parse(lines.join('\\n') || '{}');
    // stop_reason tells us WHY Claude stopped:
    //   "end_turn"   — normal completion (most common)
    //   "max_tokens" — hit the output token limit
    //   "tool_use"   — waiting for tool result (rare in Stop hook)
    if (input.stop_reason === 'max_tokens') {
      message = 'Stopped — hit token limit';
    }
  } catch {}

  const title = 'Claude Code';

  // Use each platform's built-in notification API — no npm packages needed.

  if (platform() === 'darwin') {
    // macOS: osascript triggers Notification Center
    // The notification appears top-right and goes to the notification list
    exec(\`osascript -e 'display notification "\${message}" with title "\${title}"'\`);

  } else if (platform() === 'linux') {
    // Linux: notify-send uses libnotify
    // Install with: sudo apt install libnotify-bin  (or equivalent)
    exec(\`notify-send "\${title}" "\${message}"\`);

  } else if (platform() === 'win32') {
    // Windows 10+: PowerShell Windows Runtime toast notification
    // No extra software needed — works out of the box
    const ps = [
      'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
      '$toastXml = New-Object Windows.Data.Xml.Dom.XmlDocument',
      \`$toastXml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">\${title}</text><text id="2">\${message}</text></binding></visual></toast>')\`,
      '$toast = [Windows.UI.Notifications.ToastNotification]::new($toastXml)',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Claude Code").Show($toast)',
    ].join('; ');
    exec(\`powershell -NoProfile -Command "\${ps}"\`);
  }

  // Stop hooks must NOT write to stdout — doing so confuses Claude Code.
  // Just exit cleanly (process ends when the event loop empties).
});`
  },

  // ──────────── COMMANDS ────────────
  {
    id: 'command-review', type: 'command', name: 'review', icon: '🔍',
    title: '/review — Code Review',
    description: 'Reviews a file or pasted code with severity-tagged findings in a table format.',
    content: `---
# allowed-tools: restrict what Claude can use when this command runs.
# For reviewing code, reading is fine — but we don't want automatic edits.
# Remove this field entirely to grant all available tools.
allowed-tools: Read, Bash, Grep
---

Review the provided code or file and give structured feedback.

## How to invoke

\`\`\`
/review src/auth/middleware.ts
/review   (then paste code in your next message)
\`\`\`

## Steps when invoked

1. **Read the target** — if a file path was provided, read it with the Read tool.
   Also read its imports so you understand the full context, not just the file in isolation.

2. **Run the review checklist in this order** (most critical checks first):

   Correctness
   - Does it do what it claims? Are edge cases handled (empty, null, zero, max)?
   - Are error paths handled? Do they clean up resources (DB connections, file handles)?
   - Async: are awaits present? Any race conditions or unhandled promise rejections?

   Security (OWASP Top 10)
   - SQL/shell injection: are inputs parameterized or escaped?
   - XSS: is user input sanitized before rendering?
   - Auth: endpoints check authorization, not just authentication?
   - Secrets: any credentials or API keys hardcoded?

   Performance
   - Queries inside loops (N+1 pattern)?
   - Large data loaded into memory when streaming would work?

   Readability
   - Names explain intent? Functions over ~40 lines? Nesting over 3 levels?
   - Comments explain WHY, not WHAT?

3. **Format findings as a table**:

   | Severity | Location | Issue | Fix |
   |----------|----------|-------|-----|
   | 🔴 Critical | auth.ts:42 | SQL concatenation | Use parameterized query |
   | 🟠 Major | auth.ts:87 | await missing | Add await before sendEmail() |
   | 🟡 Minor | auth.ts:23 | var named \`data\` | Rename to \`userRecord\` |

4. **End with a one-line verdict**:
   "Ready to merge" / "Fix the 2 critical issues first" / "Needs significant rework"`
  },
  {
    id: 'command-standup', type: 'command', name: 'standup', icon: '📅',
    title: '/standup — Daily Standup',
    description: 'Generates a formatted daily standup from your recent git commits.',
    content: `---
# allowed-tools: Bash is enough here — we only need to run git log commands.
# Keeping this minimal prevents Claude from wandering into unrelated work.
allowed-tools: Bash
---

Generate my daily standup update from recent git activity.

## Steps

1. **Check if we're in a git repository**:
   Run: git rev-parse --show-toplevel 2>/dev/null
   If it fails, ask the user to describe what they worked on manually.

2. **Fetch recent commits** (last 2 days covers both yesterday and today):
   Run: git log --format="%ad | %s" --date=short --since="2 days ago"
   %ad = author date  |  %s = subject (first line of commit message)
   This gives us enough to group by day and summarize the work.

3. **Group commits by day** using today's and yesterday's date strings.
   Skip merge commits — they start with "Merge branch" or "Merge pull request"
   and add noise without telling us what was actually done.

4. **Distill into plain English** (this is the most important step):
   - "fix: null check in AuthService" → "Fixed a null pointer crash in login"
   - "feat: login-page-v2-FINAL" → "Added login page"
   - Multiple small commits on one feature → one combined bullet
   - WIP commits → "Continued work on X"
   One bullet should communicate one meaningful piece of work.

5. **Output in this exact format**:

   **Yesterday**
   • Added OAuth2 login with Google (backend + frontend)
   • Fixed null pointer crash in password reset flow

   **Today**
   • Reviewing PR #142 (payment flow refactor)
   • Planning to start email notification service

   **Blockers**
   • None

Keep it to 3-6 bullets total. The reader should finish in under 10 seconds.
If today is Monday, "yesterday" means the previous Friday — skip the weekend.`
  },

  // ──────────── CLAUDE.MD ────────────
  {
    id: 'claude-md-project', type: 'claude-md', name: 'project-standards', icon: '📝',
    title: 'Project Standards Template',
    description: 'A CLAUDE.md template covering coding standards, git conventions, and guardrails for a project.',
    content: `# Project: [Your Project Name]

<!-- CLAUDE.md is read by Claude Code at the start of every session in this directory.
     Use it to set standards, preferences, and hard constraints for this project.
     Claude follows these as firm rules, not suggestions — be direct and specific.
     This file lives at the project root alongside your .gitignore. -->

## Tech stack

<!-- Tell Claude exactly what languages, frameworks, and tools this project uses.
     This saves Claude from guessing and prevents incorrect suggestions. -->
- Language: TypeScript (strict mode — "strict": true in tsconfig.json)
- Framework: [Next.js / Express / Django / etc.]
- Database: [PostgreSQL / SQLite / MongoDB / etc.]
- Test runner: [Jest / Vitest / pytest / etc.]
- Package manager: [npm / pnpm / yarn / etc.]

## Coding standards

<!-- Concrete rules Claude will follow when writing or editing code in this project.
     Be specific enough that there's no ambiguity about what to do. -->
- Never use \`any\` in TypeScript — use \`unknown\` and narrow it with type guards
- Functions should be under 40 lines. If longer, extract helpers with clear names
- All async functions must have try/catch — never leave a bare \`await\` unhandled
- Use early returns to keep nesting under 3 levels deep
- No \`console.log\` in production code — use the project logger at src/lib/logger.ts
- Imports: group as (1) Node built-ins, (2) npm packages, (3) internal src/ imports

## Testing requirements

<!-- Claude won't consider a task complete without satisfying these criteria. -->
- Write tests for every new public function
- Test files live next to source: auth.ts → auth.test.ts
- Run \`npm test\` and confirm all tests pass before marking any task done
- Don't mock the database in integration tests — use the test database instead
- Minimum: one happy-path test, one edge-case test, one error-case test per function

## Git conventions

<!-- Claude follows these when explaining what to commit or writing commit messages. -->
- Format: type: short description in imperative mood (under 72 chars)
- Types: feat, fix, refactor, test, docs, chore
- Good example: "fix: handle null session in auth middleware"
- Bad example: "fixed the bug with the auth thing"
- Never force-push to main or production branches

## Always do

<!-- Proactive checks Claude should perform without being asked. -->
- Run \`npm run lint\` and fix all errors before finishing a task
- Add new environment variables to .env.example with a placeholder and comment
- Check that generated imports resolve correctly (right path, not circular)
- Confirm that any new endpoint is protected by the auth middleware

## Never do

<!-- Hard constraints — Claude treats these as blockers, not preferences. -->
- Never hardcode API keys, passwords, or secrets — use process.env.VAR_NAME
- Never commit .env files (they're in .gitignore — keep it that way)
- Never use process.exit() inside request handlers — throw an Error instead
- Never delete or overwrite user data without a confirmation step in the code
- Never make breaking changes to the public API without a deprecation warning`
  }
];

let examplesFilter = 'all';

function loadExamples() {
  renderExampleTabs();
  renderExampleCards();
}

function renderExampleTabs() {
  const tabs = [
    { key: 'all',       label: 'All' },
    { key: 'skill',     label: 'Skills' },
    { key: 'agent',     label: 'Agents' },
    { key: 'hook-file', label: 'Hooks' },
    { key: 'command',   label: 'Commands' },
    { key: 'claude-md', label: 'CLAUDE.md' },
  ];
  document.getElementById('examples-filter-tabs').innerHTML = tabs.map(t =>
    `<button class="examples-tab ${examplesFilter === t.key ? 'active' : ''}" onclick="setExampleFilter('${t.key}')">${t.label}</button>`
  ).join('');
}

function renderExampleCards() {
  const items = examplesFilter === 'all' ? EXAMPLES : EXAMPLES.filter(e => e.type === examplesFilter);
  const grid = document.getElementById('examples-grid');
  // NOTE: never inline example content into onclick attributes — the quotes in the
  // content break the HTML and spill file content into the buttons. Use data-ids
  // and look the example up in EXAMPLES instead.
  grid.innerHTML = items.map(ex => `
    <div class="example-card">
      <div class="example-card-header">
        <span class="example-icon">${ex.icon}</span>
        <div style="flex:1;min-width:0">
          <div class="example-card-title">${escHtml(ex.title)}</div>
        </div>
        <span class="badge badge-muted example-type-badge">${escHtml(ex.type === 'hook-file' ? 'Hook' : ex.type === 'claude-md' ? 'CLAUDE.md' : ex.type.charAt(0).toUpperCase() + ex.type.slice(1))}</span>
      </div>
      <div class="example-desc">${escHtml(ex.description)}</div>
      <div class="example-code-wrap" id="wrap-${ex.id}">
        <pre class="example-code" id="code-${ex.id}">${escHtml(ex.content)}</pre>
        <div class="example-code-fade" id="fade-${ex.id}"></div>
      </div>
      <div class="example-actions">
        <button class="btn btn-secondary btn-sm" data-ex-expand="${escHtml(ex.id)}">Expand</button>
        <button class="btn btn-secondary btn-sm" data-ex-copy="${escHtml(ex.id)}">Copy</button>
        <button class="btn btn-primary btn-sm" data-ex-use="${escHtml(ex.id)}">Use This</button>
      </div>
    </div>`).join('');

  const byId = id => EXAMPLES.find(e => e.id === id);
  grid.querySelectorAll('[data-ex-expand]').forEach(b => b.onclick = () => toggleExampleExpand(b.dataset.exExpand));
  grid.querySelectorAll('[data-ex-copy]').forEach(b => b.onclick = () => { const ex = byId(b.dataset.exCopy); if (ex) copyExample(ex.content); });
  grid.querySelectorAll('[data-ex-use]').forEach(b => b.onclick = () => {
    const ex = byId(b.dataset.exUse);
    if (ex) useExample(ex.type, ex.name, ex.content, ex.hookEvent, ex.hookMatcher);
  });
}

function setExampleFilter(filter) {
  examplesFilter = filter;
  renderExampleTabs();
  renderExampleCards();
}

function toggleExampleExpand(id) {
  const wrap = document.getElementById('wrap-' + id);
  const fade = document.getElementById('fade-' + id);
  const btn  = wrap.nextElementSibling.querySelector('button');
  const expanded = wrap.classList.toggle('expanded');
  if (fade) fade.style.display = expanded ? 'none' : '';
  if (btn)  btn.textContent = expanded ? 'Collapse' : 'Expand';
}

function copyExample(content) {
  navigator.clipboard.writeText(content).then(() => toast('Copied to clipboard')).catch(() => toast('Copy failed', 'error'));
}

async function useExample(type, name, content, hookEvent, hookMatcher) {
  if (type === 'skill') {
    navigate('skills');
    setTimeout(() => openOverlay('New Skill: ' + name, content, 'markdown', 'skill', async c => {
      await api('POST', '/skills', { name, content: c });
      toast('Skill created: ' + name);
      loadSkills();
    }, true), 80);

  } else if (type === 'agent') {
    navigate('agents');
    setTimeout(() => openOverlay('New Agent: ' + name, content, 'markdown', 'agent', async c => {
      await api('POST', '/agents', { name, content: c });
      toast('Agent created: ' + name);
      loadAgents();
    }, true), 80);

  } else if (type === 'command') {
    navigate('commands');
    setTimeout(() => openOverlay('New Command: /' + name, content, 'markdown', 'command', async c => {
      await api('POST', '/commands', { name, content: c });
      toast('Command /' + name + ' created');
      loadCommands();
    }, true), 80);

  } else if (type === 'hook-file') {
    try {
      await api('POST', '/hooks/files', { name, content });
      toast('Hook file created: ' + name);
      navigate('hooks');
      await new Promise(r => setTimeout(r, 80));
      loadHooks();
      // Auto-open the add-hook modal with the file path pre-filled
      if (hookEvent) {
        setTimeout(() => {
          const folder = document.getElementById('folderPath').textContent;
          showHookAddModal(hookEvent, folder + '/hooks/' + name, `File created — register it as a ${hookEvent} hook below`, -1, hookMatcher || '');
        }, 300);
      }
    } catch (e) { toast(e.message, 'error'); }

  } else if (type === 'claude-md') {
    copyExample(content);
    navigate('claude-md');
    toast('Example copied — paste it into the editor below', 'info');
  }
}

// ===== ONE-SHOT RUNNER =====
let _runModal = { kind: null, name: null, runId: null, pollTimer: null, provider: 'claude-cli' };

async function setRunProvider(p) {
  _runModal.provider = p;
  document.getElementById('runProvCli').classList.toggle('active', p === 'claude-cli');
  document.getElementById('runProvOr').classList.toggle('active', p === 'openrouter');
  document.getElementById('runProvNote').textContent = p === 'openrouter'
    ? 'Text-only run via your OpenRouter key — the model follows the definition but CANNOT execute tools or touch files. Good for dry-runs or when Claude CLI is not installed.'
    : 'Runs locally via claude -p with all permissions — Claude can edit files and run commands.';
  document.getElementById('runPermWarning').style.display = p === 'openrouter' ? 'none' : '';
  document.getElementById('runManualWrap').style.display = p === 'openrouter' ? 'none' : '';
  document.getElementById('runOrConfig').style.display = p === 'openrouter' ? '' : 'none';
  // DOET: the button's look should signal its consequence — a full-permissions
  // run is a red action; a text-only OpenRouter run is a normal one.
  const startBtn = document.getElementById('runModalStart');
  startBtn.classList.toggle('btn-danger', p !== 'openrouter');
  startBtn.classList.toggle('btn-primary', p === 'openrouter');
  startBtn.textContent = p === 'openrouter' ? '▶ Start Text-Only Run' : '▶ Run With All Permissions';
  const cwdGroup = document.getElementById('runCwd').closest('.form-group');
  if (cwdGroup) cwdGroup.style.opacity = p === 'openrouter' ? '.5' : '1';
  // Load saved key status + model so the user knows exactly what will be used
  if (p === 'openrouter') {
    try {
      const cfg = await api('GET', '/ai-config');
      const status = document.getElementById('runOrKeyStatus');
      const keyInput = document.getElementById('runOrKey');
      if (cfg.hasOpenRouterKey) {
        status.textContent = '✓ key saved — leave blank to use it';
        status.style.color = 'var(--success)';
        keyInput.placeholder = '•••••••• (saved)';
      } else {
        status.textContent = '— required';
        status.style.color = 'var(--danger)';
        keyInput.placeholder = 'sk-or-…';
      }
      document.getElementById('runOrModel').value = cfg.openRouterModel || 'anthropic/claude-sonnet-4-5';
    } catch {}
  }
}
document.getElementById('runProvCli').onclick = () => setRunProvider('claude-cli');
document.getElementById('runProvOr').onclick  = () => setRunProvider('openrouter');

function buildManualRunCmd() {
  const { kind, name } = _runModal;
  const task = document.getElementById('runTask').value.trim();
  const file = document.getElementById('runOutputFile').value.trim() || 'run-output.jsonl';
  const prompt = (kind === 'skill' || kind === 'command') ? `/${name} ${task}`.trim()
    : kind === 'agent' ? `Act as the "${name}" agent defined in ~/.claude/agents/${name}.md.${task ? ' Task: ' + task : ''}`
    : (task || `Execute the "${name}" workflow.`);
  const q = s => `'` + String(s).replace(/'/g, `'\\''`) + `'`;
  return `claude -p ${q(prompt)} --dangerously-skip-permissions --output-format stream-json --verbose > ${q(file)}`;
}

function refreshManualRunCmd() {
  const el = document.getElementById('runManualCmd');
  if (el) el.value = buildManualRunCmd();
}
document.getElementById('runTask').addEventListener('input', refreshManualRunCmd);
document.getElementById('runOutputFile').addEventListener('input', refreshManualRunCmd);
document.getElementById('runManualCopy').onclick = () => {
  navigator.clipboard.writeText(document.getElementById('runManualCmd').value)
    .then(() => toast('Command copied — paste it into your terminal'));
};

async function openRunModal(kind, name, defaultTask) {
  _runModal = { kind, name, runId: null, pollTimer: null, provider: 'claude-cli' };
  const label = kind === 'skill' ? 'Skill' : kind === 'agent' ? 'Agent' : kind === 'command' ? 'Command' : 'Workflow';
  document.getElementById('runModalTitle').textContent = `▶ Run ${label}: ${name}`;
  document.getElementById('runTask').value = defaultTask || '';
  document.getElementById('runCwd').value = '~';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  document.getElementById('runOutputFile').value = `~/claude-runs/${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${stamp}.jsonl`;
  document.getElementById('runModalSetup').style.display = '';
  document.getElementById('runModalLive').style.display = 'none';
  document.getElementById('runInfoBox').style.display = 'none';
  refreshManualRunCmd();
  document.getElementById('runModal').classList.add('open');
  setTimeout(() => document.getElementById('runTask').focus(), 60);

  // Pick the best available provider automatically (mirrors the AI generator):
  // no Claude CLI → OpenRouter, with its key/model config visible immediately.
  try {
    const cfg = await api('GET', '/ai-config');
    setRunProvider(cfg.claudeCli ? 'claude-cli' : 'openrouter');
  } catch { setRunProvider('claude-cli'); }

  // What does this artifact do / accept? (skills, agents, commands)
  if (kind !== 'workflow') {
    try {
      const info = await api('GET', `/run/info?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`);
      const box = document.getElementById('runInfoBox');
      if (info.description || info.argumentHint || info.whenToUse) {
        document.getElementById('runInfoDesc').textContent = info.description || `${label} "${name}"`;
        const argsRow = document.getElementById('runInfoArgs');
        if (info.argumentHint) { argsRow.style.display = ''; document.getElementById('runInfoArgsVal').textContent = info.argumentHint; }
        else argsRow.style.display = 'none';
        const whenRow = document.getElementById('runInfoWhen');
        if (info.whenToUse) { whenRow.style.display = ''; whenRow.textContent = '💡 ' + info.whenToUse; }
        else whenRow.style.display = 'none';
        box.style.display = '';
        if (info.argumentHint) document.getElementById('runTask').placeholder = 'Accepts: ' + info.argumentHint;
      }
    } catch {}
  } else {
    const box = document.getElementById('runInfoBox');
    document.getElementById('runInfoDesc').textContent = 'Workflow run — the goal below is sent as a one-shot prompt that references the workflow\'s installed components.';
    document.getElementById('runInfoArgs').style.display = 'none';
    document.getElementById('runInfoWhen').style.display = 'none';
    box.style.display = '';
  }
}
window.openRunModal = openRunModal;

function closeRunModal() {
  clearInterval(_runModal.pollTimer);
  _runModal.pollTimer = null;
  document.getElementById('runModal').classList.remove('open');
}
document.getElementById('runModalClose').onclick  = closeRunModal;
document.getElementById('runModalCancel').onclick = closeRunModal;
document.getElementById('runModalDone').onclick   = closeRunModal;

document.getElementById('runModalStart').onclick = async () => {
  const outputFile = document.getElementById('runOutputFile').value.trim();
  if (!outputFile) { toast('Choose where the JSONL output should go', 'error'); return; }
  const btn = document.getElementById('runModalStart');
  btn.disabled = true; btn.textContent = 'Starting…';
  try {
    // OpenRouter: save an inline-entered key/model first (same flow as the generator)
    if (_runModal.provider === 'openrouter') {
      const inlineKey = document.getElementById('runOrKey').value.trim();
      const model = document.getElementById('runOrModel').value;
      if (inlineKey) await api('PUT', '/ai-config', { openRouterKey: inlineKey, openRouterModel: model });
    }
    const r = await api('POST', '/run/start', {
      ...(_runModal.provider === 'openrouter' ? { model: document.getElementById('runOrModel').value } : {}),
      kind: _runModal.kind,
      name: _runModal.name,
      task: document.getElementById('runTask').value.trim(),
      cwd:  document.getElementById('runCwd').value.trim(),
      provider: _runModal.provider,
      outputFile,
    });
    if (r.note) toast(r.note, 'info');
    _runModal.runId = r.id;
    document.getElementById('runFileLabel').textContent = r.file;
    document.getElementById('runModalSetup').style.display = 'none';
    document.getElementById('runModalLive').style.display = '';
    document.getElementById('runModalStop').style.display = '';
    document.getElementById('runModalDone').style.display = 'none';
    document.getElementById('runStatusDot').style.background = 'var(--warning)';
    document.getElementById('runStatusDot').style.animation = 'pulse 1.2s infinite';
    document.getElementById('runStatusText').textContent = 'Running…';
    document.getElementById('runTail').textContent = 'Waiting for output…';
    _runModal.pollTimer = setInterval(pollRunStatus, 1000);
  } catch (e) {
    toast('Run failed to start: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '▶ Start Run';
  }
};

async function pollRunStatus() {
  if (!_runModal.runId) return;
  try {
    const r = await api('GET', '/run/' + _runModal.runId);
    document.getElementById('runStatsText').textContent = `${r.lines} events · ${(r.bytes / 1024).toFixed(1)} KB`;
    if (r.tail?.length) {
      const tail = document.getElementById('runTail');
      tail.textContent = r.tail.join('\n');
      tail.scrollTop = tail.scrollHeight;
    }
    if (!r.running) {
      clearInterval(_runModal.pollTimer);
      _runModal.pollTimer = null;
      const ok = r.exitCode === 0 && !r.error;
      document.getElementById('runStatusDot').style.background = ok ? 'var(--success)' : 'var(--danger)';
      document.getElementById('runStatusDot').style.animation = 'none';
      document.getElementById('runStatusText').textContent = ok
        ? '✓ Finished — output saved'
        : (r.error || `Exited with code ${r.exitCode}`) + (r.stderr ? ' — ' + r.stderr.slice(0, 200) : '');
      document.getElementById('runModalStop').style.display = 'none';
      document.getElementById('runModalDone').style.display = '';
      toast(ok ? `Run finished — ${r.lines} events written to JSONL` : 'Run ended with errors', ok ? 'success' : 'error');
    }
  } catch {}
}

document.getElementById('runModalStop').onclick = async () => {
  if (!_runModal.runId) return;
  try { await api('POST', '/run/' + _runModal.runId + '/stop', {}); toast('Run stopped'); } catch (e) { toast(e.message, 'error'); }
};

// ===== SHARED: selectable MCP/plugin reference chips =====
// Renders every installed MCP server / plugin as a toggleable chip; selected
// names go to the AI as capabilities to leverage.
async function loadRefChips(containerId, selectedSet) {
  const el = document.getElementById(containerId);
  if (!el) return;
  selectedSet.clear();
  el.innerHTML = '<span style="font-size:11px;color:var(--text-dim)">Loading installed MCPs & plugins…</span>';
  try {
    const plugins = await api('GET', '/plugins');
    if (!plugins.length) {
      el.innerHTML = '<span style="font-size:11px;color:var(--text-dim)">No MCP servers or plugins installed — add some in the Plugins tab.</span>';
      return;
    }
    el.innerHTML = plugins.map(p =>
      `<span class="matcher-chip ref-chip" data-ref="${escHtml(p.id)}" title="${escHtml(p.description || '')}">${p.isMcpServer ? '🔌' : '🧱'} ${escHtml(p.id.split('@')[0])}</span>`
    ).join('');
    el.querySelectorAll('[data-ref]').forEach(chip => {
      chip.onclick = () => {
        const id = chip.dataset.ref;
        if (selectedSet.has(id)) { selectedSet.delete(id); chip.classList.remove('active'); }
        else { selectedSet.add(id); chip.classList.add('active'); }
      };
    });
  } catch (e) {
    el.innerHTML = `<span style="font-size:11px;color:var(--danger)">Couldn't load installed MCPs/plugins (${escHtml(e.message)}) — you can still proceed without references.</span>`;
  }
}

// ===== COMPOSE WORKFLOW FROM INSTALLED RESOURCES =====
let _composeProvider = 'claude-cli';
const _composeRefs = new Set();

async function setComposeProvider(p) {
  _composeProvider = p;
  document.getElementById('composeProvCli').classList.toggle('active', p === 'claude-cli');
  document.getElementById('composeProvOr').classList.toggle('active', p === 'openrouter');
  document.getElementById('composeOrConfig').style.display = p === 'openrouter' ? '' : 'none';
  if (p === 'openrouter') {
    try {
      const cfg = await api('GET', '/ai-config');
      const status = document.getElementById('composeOrKeyStatus');
      const keyInput = document.getElementById('composeOrKey');
      if (cfg.hasOpenRouterKey) {
        status.textContent = '✓ key saved — leave blank to use it';
        status.style.color = 'var(--success)';
        keyInput.placeholder = '•••••••• (saved)';
      } else {
        status.textContent = '— required';
        status.style.color = 'var(--danger)';
        keyInput.placeholder = 'sk-or-…';
      }
      document.getElementById('composeOrModel').value = cfg.openRouterModel || 'anthropic/claude-sonnet-4-5';
    } catch {}
  }
}
document.getElementById('composeProvCli').onclick = () => setComposeProvider('claude-cli');
document.getElementById('composeProvOr').onclick  = () => setComposeProvider('openrouter');

function composeShow(state) {
  document.getElementById('composeSetup').style.display   = state === 'setup' ? '' : 'none';
  document.getElementById('composeLoading').style.display = state === 'loading' ? '' : 'none';
  document.getElementById('composeResult').style.display  = state === 'result' ? '' : 'none';
}

async function openComposeModal() {
  composeShow('setup');
  document.getElementById('composeRefUrl').value = '';
  loadRefChips('composeRefChips', _composeRefs);
  document.getElementById('composeModal').classList.add('open');
  // Auto-select the best available provider (no CLI → OpenRouter with config open)
  try {
    const cfg = await api('GET', '/ai-config');
    setComposeProvider(cfg.claudeCli ? 'claude-cli' : 'openrouter');
  } catch { setComposeProvider('claude-cli'); }
  // Show what's in the toolbox so the user knows what the AI will work with
  try {
    const [skills, agents, hooks, commands] = await Promise.all([
      api('GET', '/skills'), api('GET', '/agents'), api('GET', '/hooks'), api('GET', '/commands'),
    ]);
    document.getElementById('composeInventoryNote').textContent =
      `Your toolbox: ${skills.length} skills · ${agents.length} agents · ${(hooks.files || []).length} hook files · ${commands.length} commands. The AI only composes from these.`;
  } catch {}
  setTimeout(() => document.getElementById('composeGoal').focus(), 60);
}
window.openComposeModal = openComposeModal;

const closeCompose = () => document.getElementById('composeModal').classList.remove('open');
document.getElementById('composeClose').onclick  = closeCompose;
document.getElementById('composeCancel').onclick = closeCompose;
document.getElementById('composeDone').onclick   = closeCompose;
document.getElementById('composeBack').onclick   = () => composeShow('setup');

const COMPOSE_TYPE_ICON = { skill: '🧩', agent: '🤖', hook: '🔗', command: '⌨️' };

document.getElementById('composeAnalyze').onclick = async () => {
  const goal = document.getElementById('composeGoal').value.trim();
  if (!goal) { toast('Describe what the workflow should do', 'error'); return; }
  composeShow('loading');
  try {
    // Save inline OpenRouter key/model first (same flow as generator + run)
    if (_composeProvider === 'openrouter') {
      const inlineKey = document.getElementById('composeOrKey').value.trim();
      const model = document.getElementById('composeOrModel').value;
      await api('PUT', '/ai-config', inlineKey ? { openRouterKey: inlineKey, openRouterModel: model } : { openRouterModel: model });
    }
    const plan = await api('POST', '/ai/compose-workflow', {
      goal,
      provider: _composeProvider,
      mcpRefs: [..._composeRefs],
      referenceUrl: document.getElementById('composeRefUrl').value.trim() || undefined,
    });
    const verdict = document.getElementById('composeVerdict');
    const v = plan.feasible;
    verdict.innerHTML = v === 'yes'
      ? '<span class="badge badge-success" style="font-size:13px;padding:6px 14px;font-weight:700">✓ Fully achievable with what you have installed</span>'
      : v === 'partial'
        ? '<span class="badge badge-warning" style="font-size:13px;padding:6px 14px;font-weight:700">◐ Partially achievable — a few pieces need to be created</span>'
        : '<span class="badge" style="font-size:13px;padding:6px 14px;font-weight:700;background:var(--danger-bg);color:var(--danger)">✕ Not achievable with current resources</span>';
    document.getElementById('composeSummary').textContent = plan.summary || '';

    const ex = document.getElementById('composeExisting');
    ex.innerHTML = plan.components.length ? `
      <div class="subhead">Uses these installed resources</div>
      ${plan.components.map(c => `
        <div class="card" style="margin-bottom:6px;padding:9px 14px;display:flex;gap:10px;align-items:center;border-left:3px solid var(--success)">
          <span>${COMPOSE_TYPE_ICON[c.type] || '📦'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px">${escHtml(c.name)} <span class="badge badge-success" style="font-size:9px">✓ installed ${escHtml(c.type)}</span></div>
            <div style="font-size:12px;color:var(--text-muted)">${escHtml(c.role || '')}</div>
          </div>
        </div>`).join('')}` : '';

    const mi = document.getElementById('composeMissing');
    mi.innerHTML = plan.missing.length ? `
      <div class="subhead">Needs to be created</div>
      ${plan.missing.map((m, i) => `
        <div class="card" style="margin-bottom:6px;padding:9px 14px;display:flex;gap:10px;align-items:center;border-left:3px solid var(--warning)">
          <span>${COMPOSE_TYPE_ICON[m.type] || '📦'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px">${escHtml(m.name || 'new-' + m.type)} <span class="badge badge-warning" style="font-size:9px">missing ${escHtml(m.type)}</span></div>
            <div style="font-size:12px;color:var(--text-muted)">${escHtml(m.description || '')}</div>
          </div>
          <button class="btn btn-primary btn-sm" data-compose-gen="${i}">✨ Generate</button>
        </div>`).join('')}` : '';
    mi.querySelectorAll('[data-compose-gen]').forEach(b => {
      b.onclick = () => {
        const m = plan.missing[Number(b.dataset.composeGen)];
        closeCompose();
        const genType = ['skill', 'agent', 'hook', 'command'].includes(m.type) ? m.type : 'skill';
        showSkillGenerator(genType, `${m.description || ''}${m.name ? ` (name it "${m.name}")` : ''}`.trim());
      };
    });

    const gd = document.getElementById('composeGuide');
    gd.innerHTML = (plan.setupGuide || []).length ? `
      <div class="subhead">How to activate</div>
      <ol style="font-size:13px;line-height:1.7;padding-left:20px;margin:0">${plan.setupGuide.map(x => `<li>${escHtml(x)}</li>`).join('')}</ol>` : '';

    composeShow('result');
  } catch (e) {
    composeShow('setup');
    toast('Analysis failed: ' + e.message, 'error');
  }
};

// ===== SKILL GENERATOR =====
let skillGenProvider = 'claude-cli';
let skillGenEditor   = null;
let skillGenType     = 'skill';
let skillGenMethod   = 'meta';      // 'meta' | 'skill-creator'
let skillGenHookExt  = '.mjs';      // '.mjs' | '.py' | '.sh'
let _skillCreators   = [];          // loaded on modal open

const HOOK_LANG_META = {
  '.mjs': { monacoLang: 'javascript', interpreter: 'node',    label: 'Node.js' },
  '.py':  { monacoLang: 'python',     interpreter: 'python3', label: 'Python'  },
  '.sh':  { monacoLang: 'shell',      interpreter: 'bash',    label: 'Bash'    },
};

function setSkillGenHookLang(ext) {
  skillGenHookExt = ext;
  ['sgLangMjs','sgLangPy','sgLangSh'].forEach(id => {
    const btn = document.getElementById(id); if (btn) btn.classList.remove('active');
  });
  const map = { '.mjs': 'sgLangMjs', '.py': 'sgLangPy', '.sh': 'sgLangSh' };
  const activeBtn = document.getElementById(map[ext]); if (activeBtn) activeBtn.classList.add('active');
  // Update name hint to show correct extension
  const hint = document.getElementById('skillGenNameHint');
  if (hint) hint.innerHTML = `Lowercase with hyphens. Will be saved as <code>${ext}</code> file.`;
}

function setSkillGenMethod(m) {
  skillGenMethod = m;
  document.getElementById('sgMethodMeta').classList.toggle('active', m === 'meta');
  document.getElementById('sgMethodCreator').classList.toggle('active', m === 'skill-creator');
  document.getElementById('sgCreatorPicker').style.display = m === 'skill-creator' ? '' : 'none';
}
window.setSkillGenMethod = setSkillGenMethod;

const SKILL_GEN_META = {
  skill: {
    promptLabel: 'What should the skill do?',
    promptHint: 'Be specific: what triggers it, what it does step by step, and what the output looks like.',
    generateBtn: '✨ Generate Skill',
    nameLabel: 'Skill Name',
    nameHint: 'Kebab-case. Becomes the slash command: <code>/skill-name</code>',
    namePlaceholder: 'my-skill-name',
    saveBtn: 'Save Skill',
    monacoLang: 'markdown',
    chipsId: 'sgChipsSkill',
    extractName: content => { const m = content.match(/^name:\s*(.+)$/m); return m ? m[1].trim().replace(/[^a-zA-Z0-9_-]/g, '-') : 'generated-skill'; },
    saveApi: (name, content) => api('POST', '/skills', { name, content }),
    afterSave: name => { navigate('skills'); loadSkills(); },
  },
  agent: {
    promptLabel: 'What should the agent do?',
    promptHint: 'Describe its single responsibility, what triggers it, and what it returns to the orchestrator.',
    generateBtn: '✨ Generate Agent',
    nameLabel: 'Agent Name',
    nameHint: 'Kebab-case. Becomes the slash command: <code>/agent-name</code>',
    namePlaceholder: 'my-agent',
    saveBtn: 'Save Agent',
    monacoLang: 'markdown',
    chipsId: 'sgChipsAgent',
    extractName: content => { const m = content.match(/^name:\s*(.+)$/m); return m ? m[1].trim().replace(/[^a-zA-Z0-9_-]/g, '-') : 'generated-agent'; },
    saveApi: (name, content) => api('POST', '/agents', { name, content }),
    afterSave: name => { navigate('agents'); loadAgents(); },
  },
  command: {
    promptLabel: 'What should the command do?',
    promptHint: 'Describe the workflow the slash command runs. Mention where the user\'s argument ($ARGUMENTS) fits in and what the output looks like.',
    generateBtn: '✨ Generate Command',
    nameLabel: 'Command Name',
    nameHint: 'Kebab-case. Becomes the slash command: <code>/command-name</code>',
    namePlaceholder: 'my-command',
    saveBtn: 'Save Command',
    monacoLang: 'markdown',
    chipsId: 'sgChipsCommand',
    extractName: content => {
      const h = content.match(/^#\s*\/([a-zA-Z0-9_-]+)/m);
      if (h) return h[1];
      const m = content.match(/^name:\s*(.+)$/m);
      return m ? m[1].trim().replace(/[^a-zA-Z0-9_-]/g, '-') : 'generated-command';
    },
    saveApi: (name, content) => api('POST', '/commands', { name, content }),
    afterSave: name => { navigate('commands'); loadCommands(); },
  },
  hook: {
    promptLabel: 'What should the hook do?',
    promptHint: 'Specify the hook event (PreToolUse, PostToolUse, Stop, SessionStart) and what it should block, log, or react to.',
    generateBtn: '✨ Generate Hook',
    nameLabel: 'Hook Filename',
    nameHint: 'Lowercase with hyphens. A <code>.mjs</code> extension will be added automatically.',
    namePlaceholder: 'block-rm-rf',
    saveBtn: 'Save Hook File',
    monacoLang: 'javascript',
    chipsId: 'sgChipsHook',
    extractName: content => { const m = content.match(/\/\/\s*([a-z][a-z0-9-]+(?:\.[a-z]+)?)/i); const n = m ? m[1].replace(/\.(mjs|js)$/, '') : 'my-hook'; return n.replace(/[^a-zA-Z0-9_-]/g, '-'); },
    saveApi: (name, content) => api('POST', '/hooks/files', { name: name + '.mjs', content }),
    afterSave: name => { navigate('hooks'); loadHooks(); },
  },
};

function setSkillGenType(type) {
  skillGenType = type;
  const meta = SKILL_GEN_META[type];
  ['skill','agent','hook','command'].forEach(t => {
    const cap = t.charAt(0).toUpperCase() + t.slice(1);
    const tab = document.getElementById('genType' + cap);
    const chips = document.getElementById('sgChips' + cap);
    if (tab)   tab.classList.toggle('active', t === type);
    if (chips) chips.style.display = t === type ? 'flex' : 'none';
  });
  document.getElementById('skillGenPromptLabel').textContent = meta.promptLabel;
  document.getElementById('skillGenPromptHint').textContent = meta.promptHint;
  document.getElementById('skillGenGenerate').textContent = meta.generateBtn;
  document.getElementById('skillGenNameLabel').textContent = meta.nameLabel;
  document.getElementById('skillGenNameHint').innerHTML = meta.nameHint;
  document.getElementById('skillGenName').placeholder = meta.namePlaceholder;
  document.getElementById('skillGenSave').textContent = meta.saveBtn;
  // Show hook-specific panels only for hook type
  const wirePanel = document.getElementById('sgHookWire');
  if (wirePanel) wirePanel.style.display = type === 'hook' ? '' : 'none';
  const langPicker = document.getElementById('sgHookLangPicker');
  if (langPicker) langPicker.style.display = type === 'hook' ? '' : 'none';
  if (type !== 'hook') { skillGenHookExt = '.mjs'; }
  document.getElementById('skillGenPrompt').placeholder =
    type === 'skill' ? 'e.g. A skill that reviews git diffs and writes release notes grouped by features, bug fixes, and breaking changes' :
    type === 'agent' ? 'e.g. An agent that audits source files for security vulnerabilities and returns a severity-ranked JSON report' :
    'e.g. A PreToolUse hook that blocks rm -rf commands on paths outside /tmp and shows a clear reason message';
}

function skillGenSetState(state) {
  document.getElementById('skillGenInput').style.display   = state === 'input'   ? '' : 'none';
  document.getElementById('skillGenLoading').style.display = state === 'loading' ? '' : 'none';
  document.getElementById('skillGenReview').style.display  = state === 'review'  ? '' : 'none';
}

async function showSkillGenerator(initialType, prefillPrompt) {
  skillGenSetState('input');
  document.getElementById('skillGenPrompt').value = '';
  const sgRepo = document.getElementById('sgRepoPath');    if (sgRepo)  sgRepo.value  = '';
  const sgStack = document.getElementById('sgTechStack');  if (sgStack) sgStack.value = '';
  const sgDom  = document.getElementById('sgDomain');      if (sgDom)   sgDom.value   = '';
  const sgPersp = document.getElementById('sgPerspective'); if (sgPersp) sgPersp.value = '';
  skillGenMethod = 'meta';
  setSkillGenMethod('meta');
  // Reset lang picker
  skillGenHookExt = '.mjs';
  setSkillGenHookLang('.mjs');
  // Reset wire panel
  const wire = document.getElementById('sgWireEnabled'); if (wire) wire.checked = false;
  const wireOpts = document.getElementById('sgWireOptions'); if (wireOpts) wireOpts.style.display = 'none';
  const wireMatcher = document.getElementById('sgWireMatcher'); if (wireMatcher) wireMatcher.value = '';
  document.getElementById('skillGenModal').classList.add('open');
  setSkillGenType(initialType || 'skill');
  if (prefillPrompt) document.getElementById('skillGenPrompt').value = prefillPrompt;

  // Load skill-creator skills (official Anthropic always included, plus any local ones)
  api('GET', '/skills/creators').then(creators => {
    _skillCreators = creators || [];
    const statusEl  = document.getElementById('sgCreatorStatus');
    const select    = document.getElementById('sgCreatorSelect');
    const nameEl    = document.getElementById('sgCreatorActiveName');
    const official  = _skillCreators.find(c => c.official);
    const local     = _skillCreators.filter(c => !c.official);

    if (statusEl) {
      statusEl.textContent = official ? (local.length ? `Official + ${local.length} local` : 'Official') : `${_skillCreators.length} found`;
      statusEl.style.color = 'var(--success)';
    }

    if (_skillCreators.length === 0) {
      if (nameEl) nameEl.textContent = 'No creators found';
      return;
    }

    // Show active creator name — no selection needed for single creator
    const first = _skillCreators[0];
    if (nameEl) nameEl.textContent = (first.official ? '🏛 ' : '📁 ') + first.name;

    // Only show the select dropdown when there are multiple creators
    if (_skillCreators.length > 1) {
      select.innerHTML = _skillCreators.map(c =>
        `<option value="${escHtml(c.name)}">${c.official ? '🏛 ' : '📁 '}${escHtml(c.name)}</option>`
      ).join('');
      select.value = first.name;
      select.style.display = '';
      // Update active name label when select changes
      select.onchange = () => {
        const found = _skillCreators.find(c => c.name === select.value) || first;
        if (nameEl) nameEl.textContent = (found.official ? '🏛 ' : '📁 ') + found.name;
      };
    }
  }).catch(e => {
    const statusEl = document.getElementById('sgCreatorStatus');
    if (statusEl) { statusEl.textContent = 'Failed to load'; statusEl.style.color = 'var(--danger)'; }
    const nameEl = document.getElementById('sgCreatorActiveName');
    if (nameEl) nameEl.textContent = '⚠ Could not load creators — will use built-in prompt';
  });

  // Load AI config and update provider buttons
  try {
    const cfg = await api('GET', '/ai-config');
    const cliBtn = document.getElementById('providerClaudeBtn');
    const orBtn  = document.getElementById('providerOpenRouterBtn');

    document.getElementById('cliStatus').textContent =
      cfg.claudeCli ? '✓ Installed and ready' : '✗ Not found — install Claude Code CLI';
    document.getElementById('cliStatus').style.color =
      cfg.claudeCli ? 'var(--success)' : 'var(--danger)';

    document.getElementById('orStatus').textContent =
      cfg.hasOpenRouterKey ? '✓ Key configured' : 'No key — configure below';
    document.getElementById('orStatus').style.color =
      cfg.hasOpenRouterKey ? 'var(--success)' : 'var(--text-muted)';

    // Auto-select best available provider
    if (cfg.claudeCli) {
      setSkillGenProvider('claude-cli');
    } else if (cfg.hasOpenRouterKey) {
      setSkillGenProvider('openrouter');
    } else {
      setSkillGenProvider('openrouter'); // show setup inline
    }

    // Sync inline model select with saved model
    document.getElementById('orModelInline').value = cfg.openRouterModel || 'anthropic/claude-sonnet-4-5';
    // Show inline config if OpenRouter selected and no key
    if (!cfg.hasOpenRouterKey && !cfg.claudeCli) {
      document.getElementById('orInlineConfig').style.display = '';
    }
  } catch {}

  setTimeout(() => document.getElementById('skillGenPrompt').focus(), 80);
}

function setSkillGenProvider(provider) {
  skillGenProvider = provider;
  document.getElementById('providerClaudeBtn').classList.toggle('active', provider === 'claude-cli');
  document.getElementById('providerOpenRouterBtn').classList.toggle('active', provider === 'openrouter');
  document.getElementById('orInlineConfig').style.display = provider === 'openrouter' ? '' : 'none';
}

function closeSkillGen() {
  document.getElementById('skillGenModal').classList.remove('open');
  if (skillGenEditor) { skillGenEditor.dispose(); skillGenEditor = null; }
}

async function runSkillGeneration() {
  const basePrompt = document.getElementById('skillGenPrompt').value.trim();
  if (!basePrompt) { toast('Describe what the skill should do', 'error'); document.getElementById('skillGenPrompt').focus(); return; }

  // Append optional context to prompt
  const repo        = document.getElementById('sgRepoPath')?.value.trim();
  const stack       = document.getElementById('sgTechStack')?.value.trim();
  const domain      = document.getElementById('sgDomain')?.value.trim();
  const perspective = document.getElementById('sgPerspective')?.value.trim();
  const ctxLines = [];
  if (repo)        ctxLines.push(`Repository/project: ${repo}`);
  if (stack)       ctxLines.push(`Tech stack: ${stack}`);
  if (domain)      ctxLines.push(`Domain: ${domain}`);
  if (perspective) ctxLines.push(`Assume the perspective of: ${perspective}`);
  const prompt = ctxLines.length ? basePrompt + '\n\nContext:\n' + ctxLines.join('\n') : basePrompt;

  // If OpenRouter inline key was entered, save it first
  if (skillGenProvider === 'openrouter') {
    const inlineKey   = document.getElementById('orKeyInline').value.trim();
    const inlineModel = document.getElementById('orModelInline').value;
    if (inlineKey) {
      try { await api('PUT', '/ai-config', { openRouterKey: inlineKey, openRouterModel: inlineModel }); }
      catch (e) { toast('Failed to save key: ' + e.message, 'error'); return; }
    }
  }

  skillGenSetState('loading');
  document.getElementById('skillGenLoadingMsg').textContent =
    skillGenProvider === 'openrouter' ? 'Calling OpenRouter API…' : 'Running claude -p (non-interactive)…';

  try {
    const meta = SKILL_GEN_META[skillGenType];
    let creatorContent = undefined;
    if (skillGenMethod === 'skill-creator') {
      if (_skillCreators.length === 0) {
        toast('Skill creators still loading — please wait a moment and try again', 'error');
        skillGenSetState('input'); return;
      }
      const select = document.getElementById('sgCreatorSelect');
      const selectedName = (select?.style.display !== 'none' && select?.value) ? select.value : _skillCreators[0]?.name;
      const found = _skillCreators.find(c => c.name === selectedName) || _skillCreators[0];
      if (found) creatorContent = found.content;
    }
    const hookLang = skillGenType === 'hook' ? skillGenHookExt : undefined;
    const { content } = await api('POST', '/ai/generate-skill', { prompt, provider: skillGenProvider, type: skillGenType, creatorContent, hookLang });

    const nameField = document.getElementById('skillGenName');
    nameField.value = meta.extractName(content);
    skillGenSetState('review');

    await new Promise(r => setTimeout(r, 50));
    if (skillGenEditor) {
      skillGenEditor.dispose();
      skillGenEditor = null;
    }
    const editorLang = skillGenType === 'hook' ? (HOOK_LANG_META[skillGenHookExt]?.monacoLang || 'javascript') : meta.monacoLang;
    skillGenEditor = createEditor('skillGenEditorWrap', editorLang, content);
    // Focus + select the name so user immediately sees it's editable
    nameField.focus();
    nameField.select();
  } catch (e) {
    skillGenSetState('input');
    toast('Generation failed: ' + e.message, 'error');
  }
}

// Wire up modal buttons
document.getElementById('skillGenClose').onclick    = closeSkillGen;
document.getElementById('skillGenCancel').onclick   = closeSkillGen;
document.getElementById('skillGenCancel2').onclick  = closeSkillGen;

// Hook wire panel interaction
document.getElementById('sgWireEnabled').addEventListener('change', function () {
  document.getElementById('sgWireOptions').style.display = this.checked ? '' : 'none';
});
document.getElementById('sgWireEvent').addEventListener('change', function () {
  const needsMatcher = ['PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest','PermissionDenied'].includes(this.value);
  document.getElementById('sgWireMatcherRow').style.display = needsMatcher ? '' : 'none';
});
document.getElementById('skillGenGenerate').onclick = runSkillGeneration;
document.getElementById('skillGenRegenerate').onclick = () => { skillGenSetState('input'); };

document.getElementById('skillGenSave').onclick = async () => {
  const name = document.getElementById('skillGenName').value.trim();
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    toast('Enter a valid name (letters, numbers, hyphens)', 'error');
    document.getElementById('skillGenName').focus();
    return;
  }
  const content = skillGenEditor ? skillGenEditor.getValue() : '';
  const meta = SKILL_GEN_META[skillGenType];
  try {
    // For hooks, use the chosen extension instead of the hardcoded .mjs in meta
    const savePromise = skillGenType === 'hook'
      ? api('POST', '/hooks/files', { name: name + skillGenHookExt, content })
      : meta.saveApi(name, content);
    await savePromise;
    toast(skillGenType.charAt(0).toUpperCase() + skillGenType.slice(1) + ' created: ' + name);

    // Wire hook to event if requested
    if (skillGenType === 'hook' && document.getElementById('sgWireEnabled')?.checked) {
      const evt        = document.getElementById('sgWireEvent')?.value || 'PreToolUse';
      const matcher    = document.getElementById('sgWireMatcher')?.value.trim() || '';
      const interp     = HOOK_LANG_META[skillGenHookExt]?.interpreter || 'node';
      const cmd        = `${interp} ~/.claude/hooks/${name}${skillGenHookExt}`;
      try {
        const settings = await api('GET', '/settings');
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks[evt]) settings.hooks[evt] = [];
        const group = { hooks: [{ type: 'command', command: cmd }] };
        if (matcher) group.matcher = matcher;
        settings.hooks[evt].push(group);
        await api('PUT', '/settings', { settings });
        toast(`Wired to ${evt}${matcher ? ' (matcher: ' + matcher + ')' : ''}`, 'success');
      } catch (e2) {
        toast('Hook saved but wiring failed: ' + e2.message, 'error');
      }
    }

    closeSkillGen();
    meta.afterSave(name);
  } catch (e) { toast(e.message, 'error'); }
};

// Type selector tabs
document.getElementById('genTypeSkill').onclick = () => setSkillGenType('skill');
document.getElementById('genTypeAgent').onclick = () => setSkillGenType('agent');
document.getElementById('genTypeHook').onclick  = () => setSkillGenType('hook');
document.getElementById('genTypeCommand').onclick = () => setSkillGenType('command');

// Provider toggle buttons
document.getElementById('providerClaudeBtn').onclick    = () => setSkillGenProvider('claude-cli');
document.getElementById('providerOpenRouterBtn').onclick = () => setSkillGenProvider('openrouter');

// Inline OpenRouter key save
document.getElementById('saveOrKeyInline').onclick = async () => {
  const key   = document.getElementById('orKeyInline').value.trim();
  const model = document.getElementById('orModelInline').value;
  if (!key) { toast('Enter an API key', 'error'); return; }
  try {
    await api('PUT', '/ai-config', { openRouterKey: key, openRouterModel: model });
    document.getElementById('orKeyInline').value = '';
    document.getElementById('orStatus').textContent = '✓ Key saved';
    document.getElementById('orStatus').style.color = 'var(--success)';
    toast('OpenRouter key saved');
  } catch (e) { toast(e.message, 'error'); }
};

// Quick-example chips in the generator
document.getElementById('skillGenModal').addEventListener('click', e => {
  if (!e.target.dataset.sgprompt) return;
  document.getElementById('skillGenPrompt').value = e.target.dataset.sgprompt;
  document.getElementById('skillGenPrompt').focus();
});

// Enter in skill name → generate
document.getElementById('skillGenPrompt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) document.getElementById('skillGenGenerate').click();
});

window.showSkillGenerator = showSkillGenerator;

window.setExampleFilter   = setExampleFilter;
window.toggleExampleExpand = toggleExampleExpand;
window.copyExample        = copyExample;
window.useExample         = useExample;

// ===== IMPROVE MODAL =====
let _improveState = { name: '', type: '', originalContent: '', method: 'direct', provider: 'claude-cli', saveCallback: null };
let _improveEditor = null;

function openImproveModal(name, type, content, saveCallback) {
  _improveState = { name, type, originalContent: content, method: 'direct', provider: 'claude-cli', saveCallback };
  document.getElementById('improveModalTitle').textContent = `Improve ${type}: ${name}`;
  document.getElementById('improveFeedback').value = '';
  setImproveMethod('direct');
  _showImproveState('input');
  document.getElementById('improveModal').classList.add('open');
  // Auto-detect best provider
  api('GET', '/ai-config').then(cfg => {
    const cliEl = document.getElementById('improveCliStatus');
    const orEl  = document.getElementById('improveOrStatus');
    if (cliEl) { cliEl.textContent = cfg.claudeCli ? '✓ Ready' : '✗ Not installed'; cliEl.style.color = cfg.claudeCli ? 'var(--success)' : 'var(--danger)'; }
    if (orEl)  { orEl.textContent  = cfg.hasOpenRouterKey ? '✓ Key set' : 'No key'; orEl.style.color = cfg.hasOpenRouterKey ? 'var(--success)' : 'var(--text-muted)'; }
    setImproveProvider(cfg.claudeCli ? 'claude-cli' : 'openrouter');
  }).catch(() => {});
}
window.openImproveModal = openImproveModal;

function setImproveMethod(m) {
  _improveState.method = m;
  document.getElementById('improveMethodDirect').classList.toggle('active', m === 'direct');
  document.getElementById('improveMethodFeedback').classList.toggle('active', m === 'feedback');
  document.getElementById('improveFeedbackRow').style.display = m === 'feedback' ? '' : 'none';
}
window.setImproveMethod = setImproveMethod;

function setImproveProvider(p) {
  _improveState.provider = p;
  document.getElementById('improveProviderCli').classList.toggle('active', p === 'claude-cli');
  document.getElementById('improveProviderOr').classList.toggle('active', p === 'openrouter');
}
window.setImproveProvider = setImproveProvider;

function _showImproveState(s) {
  document.getElementById('improveInput').style.display   = s === 'input'   ? '' : 'none';
  document.getElementById('improveLoading').style.display = s === 'loading' ? '' : 'none';
  document.getElementById('improveReview').style.display  = s === 'review'  ? '' : 'none';
}

function _closeImproveModal() {
  document.getElementById('improveModal').classList.remove('open');
  if (_improveEditor) { _improveEditor.dispose(); _improveEditor = null; }
}

document.getElementById('improveClose').onclick   = _closeImproveModal;
document.getElementById('improveCancel').onclick  = _closeImproveModal;

document.getElementById('improveRunBtn').onclick = async () => {
  const feedback = _improveState.method === 'feedback'
    ? document.getElementById('improveFeedback').value.trim() : '';
  if (_improveState.method === 'feedback' && !feedback) {
    toast('Describe what needs improving', 'error');
    document.getElementById('improveFeedback').focus();
    return;
  }
  const apiProvider = _improveState.provider === 'openrouter' ? 'openrouter' : 'claude';
  document.getElementById('improveLoadingMsg').textContent =
    apiProvider === 'openrouter' ? 'Calling OpenRouter API…' : 'Running claude -p…';
  _showImproveState('loading');
  try {
    const { content } = await api('POST', '/ai/improve-skill', {
      type:     _improveState.type,
      content:  _improveState.originalContent,
      feedback: feedback || null,
      provider: apiProvider,
    });
    _showImproveState('review');
    await new Promise(r => setTimeout(r, 50));
    if (_improveEditor) { _improveEditor.dispose(); _improveEditor = null; }
    const lang = _improveState.type === 'hook' ? 'javascript' : 'markdown';
    _improveEditor = createEditor('improveEditorWrap', lang, content);
  } catch (e) {
    _showImproveState('input');
    toast('Improvement failed: ' + e.message, 'error');
  }
};

document.getElementById('improveRegenBtn').onclick = () => {
  if (_improveEditor) { _improveEditor.dispose(); _improveEditor = null; }
  _showImproveState('input');
};

document.getElementById('improveAcceptBtn').onclick = async () => {
  const content = _improveEditor ? _improveEditor.getValue() : '';
  try {
    await _improveState.saveCallback(content);
    toast(`${_improveState.name} updated successfully`);
    _closeImproveModal();
  } catch (e) { toast(e.message, 'error'); }
};

// ===== WORKFLOWS =====
// Component content strings — top-level template literals to avoid nesting issues
const WF = {};

WF['session-git-context.mjs'] =
`#!/usr/bin/env node
// session-git-context.mjs — SessionStart hook: inject git branch + recent commits
import { execSync } from 'node:child_process';
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  try {
    const branch = execSync('git branch --show-current', { encoding: 'utf8', stdio: 'pipe' }).trim();
    const log    = execSync('git log --oneline -5',        { encoding: 'utf8', stdio: 'pipe' }).trim();
    process.stderr.write('[session] Branch: ' + branch + '\\nRecent commits:\\n' + log + '\\n');
  } catch {}
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
});
`;

WF['guard-push.mjs'] =
`#!/usr/bin/env node
// guard-push.mjs — PreToolUse/Bash: block git push if no tests ran this session
import readline from 'node:readline';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const FLAG = join(tmpdir(), 'claude-tests-ran.flag');
const TEST_CMDS = ['npm test', 'yarn test', 'pnpm test', 'pytest', 'go test', 'jest', 'vitest', 'mocha', 'cargo test'];
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  try {
    const input = JSON.parse(lines.join('\\n') || '{}');
    if (input.tool_name !== 'Bash') { process.exit(0); return; }
    const cmd = (input.tool_input && input.tool_input.command) || '';
    if (TEST_CMDS.some(t => cmd.includes(t))) writeFileSync(FLAG, '1');
    if (cmd.includes('git push') && !existsSync(FLAG)) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: 'No tests detected before git push. Run your test suite first, then push.' }));
      process.exit(0);
    }
    if (cmd.includes('git push') && existsSync(FLAG)) { try { unlinkSync(FLAG); } catch {} }
  } catch {}
  process.exit(0);
});
`;

WF['commit-messages'] =
`---
name: commit-messages
description: >
  Generates a conventional commit message from staged git changes.
  Detects feat/fix/chore/etc from the diff, infers scope from affected files,
  writes a subject line under 72 chars, and adds a body when changes are complex.
when_to_use: >
  Use when user says "commit message", "write a commit", "generate commit",
  "conventional commit", "commit this", "stage and commit", "what should I commit".
---

# Commit Message Generator

Generate a conventional commit message from the current staged diff.

## Steps

1. Get the staged diff:
   git diff --cached
   If nothing is staged, use: git diff HEAD

2. Determine:
   - **Type**: feat / fix / refactor / chore / docs / test / perf / style
   - **Scope**: main module/directory affected (auth, api, ui, db, etc.)
   - **Breaking change**: API removed, signature changed, export dropped

3. Write the subject line (max 72 chars, imperative mood):
   type(scope): short description

   Examples:
   feat(auth): add OAuth2 login with Google
   fix(api): handle null response in user endpoint
   chore(deps): upgrade express to v5

4. Add a body if the change is non-obvious:
   - Why this change was made (not what — the diff shows what)
   - BREAKING CHANGE: prefix for breaking changes
   - Closes #123 for issue references

5. Output the final commit command ready to run:
   git commit -m "type(scope): description"

If nothing is staged and no changes exist, ask what the user wants to commit.
`;

WF['review'] =
`# /review

Run a thorough code review on the current changes or the specified PR.

Review the staged git diff (or a PR if a number or URL is provided as an argument).
Check for: logic errors, security issues, performance problems, missing tests, and style issues.
Output a structured markdown report with severity ratings (CRITICAL / HIGH / MEDIUM / LOW).
End with a recommendation: APPROVE, REQUEST CHANGES, or BLOCK.
`;

WF['code-reviewer'] =
`---
name: code-reviewer
description: >
  Use when user asks to "review code", "check my changes", "review this PR",
  "look at this diff", or "give feedback on these changes". Performs a structured
  code review and returns a severity-ranked markdown report. Does not fix — reports only.
when_to_use: >
  review code, check my PR, review this diff, give feedback on changes, review pull request
tools: Bash, Read
---

# Code Reviewer Agent

You are a code review agent. Review code changes and return a severity-ranked findings report. You do not fix — you report.

## Input

Staged diff, PR number/URL, or file path from the user's argument.

## Steps

1. Get the diff:
   - PR number/URL: gh pr diff <number>
   - Staged: git diff --cached
   - File path: read the file, compare to git HEAD version

2. Scan in priority order:
   - CRITICAL: security bugs, data loss risk, auth bypass, hardcoded secrets
   - HIGH: logic errors, null crashes, race conditions, broken error handling
   - MEDIUM: N+1 queries, unbounded loops, missing input validation
   - LOW: dead code, naming problems, style inconsistencies

3. Output this exact format:

   ## Code Review

   ### CRITICAL
   - **src/auth.js:42** — JWT secret hardcoded. Move to process.env.JWT_SECRET.

   ### Summary
   N issues (X critical). Recommendation: APPROVE / REQUEST CHANGES / BLOCK.

4. If no issues: "LGTM — no issues found. Recommendation: APPROVE."

## Constraints
- Do NOT modify any files.
- Report exact file:line references, not vague descriptions.
`;

WF['pr-review'] =
`---
name: pr-review
description: >
  Reviews a pull request for logic errors, security issues, and style problems.
  Outputs a structured markdown report with CRITICAL/HIGH/MEDIUM/LOW severity ratings.
when_to_use: >
  Use when user says "review this PR", "check pull request", "look at PR #N",
  "review my changes", "feedback on this diff", or pastes a GitHub PR URL.
argument-hint: "[PR number or URL]"
---

# PR Review

Review a pull request and produce a structured findings report.

## Steps

1. Get the diff. If given a PR number or URL:
   gh pr diff <number>
   If pasted directly, use the provided diff text.

2. Scan for issues in priority order:
   CRITICAL: security bugs, auth bypass, data loss, hardcoded secrets
   HIGH: logic errors, null dereferences, race conditions
   MEDIUM: N+1 queries, unbounded loops, missing error handling
   LOW: dead code, naming, style, missing docs on complex logic

3. For each finding: file + line, issue description, why it matters.

4. Output:

   ## PR Review: <title>

   ### CRITICAL
   - **src/auth.js:42** — JWT secret hardcoded. Use environment variable.

   ### Summary
   X issues. Recommend: APPROVE / REQUEST CHANGES / BLOCK.

5. If no issues: "LGTM — Recommend: APPROVE."

Ask which directory to focus on if PR exceeds 500 files.
`;

WF['block-dangerous-bash.mjs'] =
`#!/usr/bin/env node
// block-dangerous-bash.mjs — PreToolUse/Bash: block destructive shell commands
import readline from 'node:readline';
const RULES = [
  { test: c => (c.includes('rm -rf') || c.includes('rm -fr')) && !c.includes('/tmp') && !c.includes('node_modules'), reason: 'rm -rf outside /tmp' },
  { test: c => c.includes('chmod 777'), reason: 'chmod 777 grants world-write permissions' },
  { test: c => c.includes(':(){:|:&};:') || c.includes(':(){ :|:& };:'), reason: 'Fork bomb pattern' },
  { test: c => c.includes('> /dev/sda') || c.includes('> /dev/nvme') || c.includes('> /dev/disk'), reason: 'Write to raw block device is destructive' },
];
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  try {
    const input = JSON.parse(lines.join('\\n') || '{}');
    if (input.tool_name !== 'Bash') { process.exit(0); return; }
    const cmd = (input.tool_input && input.tool_input.command) || '';
    for (const rule of RULES) {
      if (rule.test(cmd)) {
        process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Blocked: ' + rule.reason + '. Command: ' + cmd.slice(0, 100) }));
        process.exit(0);
      }
    }
  } catch {}
  process.exit(0);
});
`;

WF['protect-secrets.mjs'] =
`#!/usr/bin/env node
// protect-secrets.mjs — PreToolUse/Write+Edit: block writing hardcoded secrets
import readline from 'node:readline';
const PROTECTED = ['.env', '.env.local', '.env.production', '.env.staging', 'secrets.json', 'credentials.json'];
const SECRET_KEYS = ['password=', 'api_key=', 'apikey=', 'secret=', 'private_key=', 'access_token='];
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  try {
    const input = JSON.parse(lines.join('\\n') || '{}');
    if (!['Write', 'Edit'].includes(input.tool_name)) { process.exit(0); return; }
    const filePath = (input.tool_input && (input.tool_input.file_path || input.tool_input.path)) || '';
    const content  = (input.tool_input && (input.tool_input.content || input.tool_input.new_string)) || '';
    const filename = filePath.split('/').pop();
    if (PROTECTED.includes(filename) || filePath.includes('/.ssh/')) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Writing to protected path: ' + filePath + '. Confirm this is intentional.' }));
      process.exit(0);
    }
    const lower = content.toLowerCase();
    for (const kw of SECRET_KEYS) {
      const idx = lower.indexOf(kw);
      if (idx === -1) continue;
      const val = content.slice(idx + kw.length, idx + kw.length + 6).trim();
      if (val && !val.startsWith('{') && !val.startsWith('$') && !val.startsWith('<')) {
        process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Possible hardcoded secret (' + kw + ') in content for ' + filePath + '. Use environment variables instead.' }));
        process.exit(0);
      }
    }
  } catch {}
  process.exit(0);
});
`;

WF['security-audit'] =
`---
name: security-audit
description: >
  Audits source code for security vulnerabilities: hardcoded secrets, injection vectors,
  auth bypass, and OWASP top-10 issues. Returns a severity-ranked findings report.
when_to_use: >
  Use when user says "security audit", "check for vulnerabilities", "scan for secrets",
  "OWASP scan", "find security bugs", "audit this code", "is this secure".
argument-hint: "[path to audit, defaults to current directory]"
---

# Security Audit

Scan source files for security vulnerabilities and return a ranked findings report.

## Steps

1. Get the path to audit (from argument or use current directory).

2. Find source files (limit to 200):
   find <path> -type f \\( -name "*.js" -o -name "*.ts" -o -name "*.py" -o -name "*.go" \\) | head -200

3. Scan each file for these patterns in priority order:
   CRITICAL: hardcoded passwords/API keys/tokens as literal values
   CRITICAL: JWT/OAuth secrets in source (not from env)
   HIGH: SQL string concatenation (user input not parameterized)
   HIGH: eval() or exec() on user-controlled input
   HIGH: shell injection via string interpolation with user data
   MEDIUM: missing auth checks on route handlers
   MEDIUM: unvalidated redirects using user input
   LOW: verbose errors exposing stack traces or DB schema

4. For each finding output file path, line number, vulnerable snippet, and fix recommendation.

5. Summary table:
   | Severity | Count |
   |----------|-------|
   | CRITICAL | X     |
   Immediate action required for all CRITICAL items.

If no files found in scope, say so and stop.
`;

WF['audit'] =
`# /audit

Run a security audit on the codebase or a specified path.

Scan source files for security vulnerabilities: hardcoded secrets, injection vectors,
SQL injection, eval on user input, missing auth checks, and OWASP top-10 issues.

Accept an optional path argument. Default to the current directory if none provided.
Output a severity-ranked findings report (CRITICAL / HIGH / MEDIUM / LOW) with exact
file paths, line numbers, code snippets, and specific remediation steps for each issue.
`;

WF['auto-run-tests.mjs'] =
`#!/usr/bin/env node
// auto-run-tests.mjs — PostToolUse/Edit+Write: run tests automatically after file changes
import { execSync } from 'node:child_process';
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  try {
    const input = JSON.parse(lines.join('\\n') || '{}');
    if (!['Edit', 'Write'].includes(input.tool_name)) { process.exit(0); return; }
    const file = (input.tool_input && input.tool_input.file_path) || '';
    // Skip test files themselves to avoid infinite loops
    if (!file || file.includes('.test.') || file.includes('.spec.') || file.includes('__tests__')) { process.exit(0); return; }
    let cmd = null;
    try {
      const pkg = JSON.parse(execSync('cat package.json', { encoding: 'utf8', stdio: 'pipe' }));
      if (pkg.scripts && pkg.scripts.test) cmd = 'npm test -- --passWithNoTests 2>&1 | tail -25';
    } catch {}
    if (!cmd) { try { execSync('which pytest', { stdio: 'pipe' }); cmd = 'pytest -x -q 2>&1 | tail -25'; } catch {} }
    if (!cmd) { process.exit(0); return; }
    try {
      const out = execSync(cmd, { encoding: 'utf8', timeout: 60000 });
      process.stderr.write('Tests passed after editing ' + file.split('/').pop() + '\\n' + out);
    } catch (e) {
      const out = (e.stdout || '') + (e.stderr || '');
      process.stdout.write(JSON.stringify({ continue: true, stopReason: 'Tests failed after editing ' + file.split('/').pop() + '. Fix the failures before continuing.\\n' + out.slice(0, 500) }));
    }
  } catch {}
  process.exit(0);
});
`;

WF['write-tests'] =
`---
name: write-tests
description: >
  Writes comprehensive unit tests for any function, class, or module.
  Covers happy path, edge cases (null, empty, boundary values), error paths, and async behavior.
  Auto-detects the project's test framework and follows existing test conventions.
when_to_use: >
  Use when user says "write tests", "add unit tests", "test this function",
  "generate tests", "add test coverage", "write specs", "test this class".
argument-hint: "[file path or function name]"
---

# Test Writer

Write comprehensive unit tests for the given code.

## Steps

1. Get the target from the argument or ask if missing. Read the source file.

2. Detect the test framework:
   - Check package.json for jest / vitest / mocha / jasmine
   - Check for pytest.ini or conftest.py (Python)
   - Check for *_test.go (Go) or tests/ in Cargo.toml (Rust)
   Default: Jest for JS/TS, pytest for Python.

3. Read existing test files to match naming patterns, assertion style, and file location.

4. Write tests covering:
   - Happy path: normal inputs produce expected outputs
   - Edge cases: null/undefined/empty, zero, negative numbers, max values
   - Error paths: bad input throws the right error, network failures handled
   - Async: promises resolve and reject correctly, timeouts handled
   - Boundary values: off-by-one errors, array limits, string length limits

5. Save to the project-standard location:
   - Jest/Vitest: <name>.test.ts in same directory
   - pytest: tests/test_<name>.py
   - Go: <name>_test.go in same package

6. Run the tests to confirm they pass:
   <test runner> <test file>

Fix any test failures before finishing.
`;

WF['test-diagnostics'] =
`---
name: test-diagnostics
description: >
  Use when tests are failing and user needs help understanding why. Reads test output,
  traces failures to source code, diagnoses root cause, and returns specific fix
  recommendations with file paths and line numbers. Does not apply fixes — reports only.
when_to_use: >
  Use when user says "tests are failing", "diagnose test failure", "why is this test failing",
  "debug test", "fix failing tests", "test error", "test output".
tools: Bash, Read
---

# Test Diagnostics Agent

You are a test diagnostics agent. Analyze failures and return fix recommendations. You do not fix code — you diagnose.

## Input

Test failure output from user's message, or run the test suite to get it.

## Steps

1. Get the failure output. If not provided:
   npm test 2>&1 | tail -60
   or: pytest -v 2>&1 | tail -60

2. For each failure, identify:
   - Test name and file
   - Error type (AssertionError, TypeError, NetworkError, etc.)
   - First stack frame in project source (not node_modules or venv)

3. Read the relevant source file at the failing line. Understand expected vs actual.

4. Classify root cause:
   - Logic error in source (most common)
   - Test expectation is wrong (expected value incorrect)
   - Missing mock, stub, or test setup
   - Environment issue (missing env var, wrong path, DB not seeded)
   - Race condition or async timing issue

5. Output for each failure:

   ### Test: <test name>
   **File:** src/routes/users.js:42
   **Root cause:** Missing null check — returns 200 with null body when user not found.
   **Fix:** Add \`if (!user) return res.status(404).json({ error: 'Not found' });\` after line 41.

## Constraints
- Do NOT modify any files.
- If the test expectation is wrong, explain why before suggesting a test change.
`;

WF['doc-reminder.mjs'] =
`#!/usr/bin/env node
// doc-reminder.mjs — Stop hook: remind to document new exported functions
import { execSync } from 'node:child_process';
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', l => lines.push(l));
rl.on('close', () => {
  try {
    const input = JSON.parse(lines.join('\\n') || '{}');
    if (input.stop_hook_active) { process.exit(0); return; } // infinite loop guard
    const diff = execSync('git diff --cached 2>/dev/null || git diff HEAD 2>/dev/null || echo ""', { encoding: 'utf8', stdio: 'pipe' });
    const added = diff.split('\\n').filter(l =>
      l.startsWith('+') && !l.startsWith('+++') &&
      (l.includes('export function') || l.includes('export const') || l.includes('export class') || l.includes('export async'))
    );
    if (added.length === 0) { process.exit(0); return; }
    const docLines = diff.split('\\n').filter(l => l.startsWith('+') && (l.includes('/**') || l.includes('* @param') || l.includes('"""')));
    if (docLines.length < added.length) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: added.length + ' new export(s) found without JSDoc/docstrings. Consider documenting them before finishing.'
      }));
    }
  } catch {}
  process.exit(0);
});
`;

WF['explain-code'] =
`---
name: explain-code
description: >
  Explains any code file or snippet in plain language. Covers what it does,
  how it works step by step, design patterns used, and non-obvious gotchas.
when_to_use: >
  Use when user says "explain this code", "what does this do", "how does this work",
  "walk me through this", "what is this function doing", "explain this file".
argument-hint: "[file path or paste the code]"
---

# Code Explainer

Explain the given code clearly enough that a developer new to this codebase can understand it.

## Steps

1. Get the code from the argument path or pasted text. If a path: read the file.

2. Write a one-paragraph summary: what this code does and why it exists.

3. Walk through each logical section:
   - Name the section (setup, validation, main logic, error handling, exports)
   - Explain WHAT it does and WHY — not line by line, section by section
   - Highlight non-obvious logic, invariants, or important side effects

4. Call out design patterns if present:
   - Structural: Singleton, Factory, Observer, Strategy, Decorator
   - Framework patterns: middleware, hooks, reducers, interceptors
   - Concurrency: async/await, channels, event emitters, queues

5. List gotchas and important notes:
   - Side effects not obvious from the function name
   - Order-dependent initialization
   - Performance characteristics
   - Known limitations or active TODOs

Keep it jargon-free. Use analogies for complex concepts.
`;

WF['doc-gen'] =
`# /doc-gen

Generate documentation for the current file or a specified path.

Read the source file, understand each exported function/class/method, and generate:
- JSDoc comments (JS/TS), Python docstrings, or Go doc comments — match the project style
- For each public function: description, parameters with types, return value, example usage
- For each class: constructor params, public methods summary, usage example

Accept an optional file path argument. Default to the file currently in context.
Write the docs as comments in the source file unless the user asks for a separate markdown file.
After writing, show a summary of how many functions were documented.
`;

const WORKFLOWS = [
  {
    id: 'smart-commit',
    icon: '📝',
    name: 'Smart Commit',
    tagline: 'Git context injection · conventional commits · push guard',
    description: 'Injects git branch and recent commits as context on every session start. Adds a commit-messages skill for on-demand conventional commit generation. Blocks git push if no tests were run this session.',
    flowSteps: [
      { icon: '🚀', text: 'Session opens → hook reads git branch + last 5 commits' },
      { icon: '📋', text: 'Context injected → Claude always knows what\'s in progress' },
      { icon: '✍️', text: '"commit message" → skill generates conventional commit' },
      { icon: '🛡️', text: 'git push → hook checks tests were run first' },
    ],
    components: [
      { type: 'hook',  icon: '🔗', name: 'session-git-context.mjs', event: 'SessionStart', matcher: '',     desc: 'Reads current git branch and last 5 commits, injects them as session context.',               content: WF['session-git-context.mjs'] },
      { type: 'skill', icon: '🧩', name: 'commit-messages',          event: '',             matcher: '',     desc: 'Generates conventional commit messages (feat/fix/chore) from staged git diff.',              content: WF['commit-messages'] },
      { type: 'hook',  icon: '🔗', name: 'guard-push.mjs',           event: 'PreToolUse',   matcher: 'Bash', desc: 'Blocks git push if no test suite was run this session. Resets the flag after each push.',    content: WF['guard-push.mjs'] },
    ],
  },
  {
    id: 'code-review',
    icon: '👁️',
    name: 'Code Review Pipeline',
    tagline: '/review command · dedicated agent · structured report',
    description: 'A /review slash command triggers a code-reviewer agent that scans diffs by severity and produces a structured CRITICAL/HIGH/MEDIUM/LOW findings report. The pr-review skill handles larger PR workflows.',
    flowSteps: [
      { icon: '⌨️', text: 'User types /review or asks to review code' },
      { icon: '🤖', text: 'Code-reviewer agent fetches diff + scans by priority' },
      { icon: '📋', text: 'PR-review skill formats the severity-ranked report' },
      { icon: '✅', text: 'APPROVE / REQUEST CHANGES / BLOCK recommendation' },
    ],
    components: [
      { type: 'command', icon: '⌨️', name: 'review',         event: '', matcher: '', desc: 'Slash command /review — triggers a code review on staged changes or a specific PR.',               content: WF['review'] },
      { type: 'agent',   icon: '🤖', name: 'code-reviewer',  event: '', matcher: '', desc: 'Specialized agent: fetches diff, scans CRITICAL→LOW, returns severity-ranked report.',             content: WF['code-reviewer'] },
      { type: 'skill',   icon: '🧩', name: 'pr-review',      event: '', matcher: '', desc: 'Reviews a PR with structured sections and a final recommendation. Handles large PRs gracefully.',  content: WF['pr-review'] },
    ],
  },
  {
    id: 'security-guardian',
    icon: '🛡️',
    name: 'Security Guardian',
    tagline: 'Block dangerous commands · protect secrets · on-demand audit',
    description: 'Two always-on hooks prevent destructive shell commands and accidental secret commits. An /audit command and security-audit skill provide on-demand vulnerability scanning with OWASP coverage.',
    flowSteps: [
      { icon: '🔒', text: 'Every Bash command → hook checks dangerous patterns' },
      { icon: '🔑', text: 'Every file write → hook scans for hardcoded secrets' },
      { icon: '🔍', text: '/audit → skill scans codebase for vulnerabilities' },
      { icon: '📊', text: 'Severity report: CRITICAL items need immediate fix' },
    ],
    components: [
      { type: 'hook',    icon: '🔗', name: 'block-dangerous-bash.mjs', event: 'PreToolUse', matcher: 'Bash',       desc: 'Blocks rm -rf outside /tmp, chmod 777, dd to block devices, fork bombs.',                    content: WF['block-dangerous-bash.mjs'] },
      { type: 'hook',    icon: '🔗', name: 'protect-secrets.mjs',      event: 'PreToolUse', matcher: 'Write|Edit', desc: 'Blocks writing hardcoded passwords, API keys, and tokens to source files.',                  content: WF['protect-secrets.mjs'] },
      { type: 'skill',   icon: '🧩', name: 'security-audit',           event: '',           matcher: '',           desc: 'Scans source files for OWASP issues: injection vectors, auth bypass, missing validation.',  content: WF['security-audit'] },
      { type: 'command', icon: '⌨️', name: 'audit',                    event: '',           matcher: '',           desc: 'Slash command /audit — triggers security-audit on current directory or a given path.',       content: WF['audit'] },
    ],
  },
  {
    id: 'tdd-loop',
    icon: '🔁',
    name: 'TDD Loop',
    tagline: 'Auto-run tests on edit · write-tests skill · failure diagnostics',
    description: 'Tests run automatically after every file edit. A write-tests skill generates comprehensive test suites on demand. When tests fail, a test-diagnostics agent reads the output and pinpoints the exact root cause.',
    flowSteps: [
      { icon: '✏️', text: 'Claude edits a source file' },
      { icon: '🧪', text: 'PostToolUse hook auto-runs the test suite' },
      { icon: '❌', text: 'Tests fail → agent diagnoses root cause + suggests fix' },
      { icon: '🧩', text: '"write tests" → skill generates full coverage suite' },
    ],
    components: [
      { type: 'hook',  icon: '🔗', name: 'auto-run-tests.mjs', event: 'PostToolUse', matcher: 'Edit|Write', desc: 'Runs npm test or pytest after every file edit. Injects failure output as redirect context.', content: WF['auto-run-tests.mjs'] },
      { type: 'skill', icon: '🧩', name: 'write-tests',         event: '',            matcher: '',           desc: 'Writes comprehensive unit tests: happy path, edge cases, error paths, async behavior.',       content: WF['write-tests'] },
      { type: 'agent', icon: '🤖', name: 'test-diagnostics',    event: '',            matcher: '',           desc: 'Reads test failures, traces to source, diagnoses root cause, suggests exact fix location.',   content: WF['test-diagnostics'] },
    ],
  },
  {
    id: 'doc-automation',
    icon: '📚',
    name: 'Documentation Automation',
    tagline: 'Explain any code · /doc-gen command · undocumented export reminder',
    description: 'An explain-code skill breaks down any code in plain language. A /doc-gen command generates JSDoc/docstrings for any file. A Stop hook detects new undocumented exports and redirects Claude to add documentation.',
    flowSteps: [
      { icon: '❓', text: '"explain this code" → skill explains in plain language' },
      { icon: '📝', text: '/doc-gen → generates JSDoc/docstrings for the file' },
      { icon: '🏁', text: 'Claude finishes → Stop hook checks for undocumented exports' },
      { icon: '💬', text: 'Hook redirects Claude to add missing documentation' },
    ],
    components: [
      { type: 'skill',   icon: '🧩', name: 'explain-code',     event: '',    matcher: '', desc: 'Explains code in plain language: what it does, how it works, design patterns, and gotchas.',     content: WF['explain-code'] },
      { type: 'command', icon: '⌨️', name: 'doc-gen',          event: '',    matcher: '', desc: 'Slash command /doc-gen — generates JSDoc comments or docstrings for the specified file.',         content: WF['doc-gen'] },
      { type: 'hook',    icon: '🔗', name: 'doc-reminder.mjs', event: 'Stop', matcher: '', desc: 'Checks staged changes for new exports without JSDoc. Redirects Claude to document them first.', content: WF['doc-reminder.mjs'] },
    ],
  },
];

// Wada discipline: color is for STATE, not taxonomy — type badges stay neutral
const WF_TYPE_CLASS = { hook: 'badge-muted', skill: 'badge-muted', agent: 'badge-muted', command: 'badge-muted' };

async function loadWorkflows() {
  let myWorkflows = [];
  try { myWorkflows = await api('GET', '/workflows'); }
  catch (e) { toast('Could not load your workflows: ' + e.message, 'error'); }

  // What's actually on disk — a workflow is runnable only when installed
  const inv = { skill: new Set(), agent: new Set(), hook: new Set(), command: new Set() };
  try {
    const [sk, ag, hk, cm] = await Promise.all([
      api('GET', '/skills'), api('GET', '/agents'), api('GET', '/hooks'), api('GET', '/commands'),
    ]);
    sk.forEach(x => inv.skill.add(x.name.toLowerCase()));
    ag.forEach(x => inv.agent.add(x.name.toLowerCase()));
    (hk.files || []).forEach(x => inv.hook.add(x.name.toLowerCase()));
    cm.forEach(x => inv.command.add(x.name.toLowerCase()));
  } catch {}
  const compInstalled = c => inv[c.type]?.has(String(c.name).toLowerCase());
  const wfStatus = w => {
    const n = w.components.filter(compInstalled).length;
    return { n, total: w.components.length, full: n === w.components.length };
  };
  const section = document.getElementById('section-workflows');
  const myWfHtml = myWorkflows.length ? `
    <div class="subhead">Your Workflows</div>
    <div class="workflow-grid" style="margin-bottom:22px">
      ${myWorkflows.map(w => `
        <div class="workflow-card">
          <div class="workflow-card-top">
            <span class="workflow-card-icon">🛠️</span>
            <div>
              <div class="workflow-card-name">${escHtml(w.title || w.name)}</div>
              <div class="workflow-card-tagline">${escHtml((w.components || []).map(c => c.type).join(' · '))} · created ${fmtDate(w.createdAt)}</div>
            </div>
          </div>
          <div class="workflow-card-desc">${escHtml(w.description || '')}</div>
          <div class="workflow-card-badges" style="display:flex;align-items:center;justify-content:space-between;gap:6px">
            <div>${(w.components || []).map(c => `<span class="badge ${WF_TYPE_CLASS[c.type] || 'badge-muted'}">${escHtml(c.type)}</span>`).join('')}</div>
            <div style="display:flex;gap:5px;flex-shrink:0">
              <button class="btn btn-run btn-sm" data-mywf-run="${escHtml(w.name)}" title="One-shot fully automated run — bypasses all permission prompts">▶ Run</button>
              <button class="btn btn-secondary btn-sm" data-mywf-usage="${escHtml(w.name)}" title="How to invoke this workflow end to end">📖 Usage</button>
              <button class="btn btn-danger btn-sm" data-mywf-del="${escHtml(w.name)}" title="Remove from this list (does not delete the installed components)">✕</button>
            </div>
          </div>
        </div>`).join('')}
    </div>` : '';
  section.innerHTML = `
    <div class="section-header">
      <div>
        <div class="section-title">Workflows</div>
        <div class="section-subtitle">Coordinated sets of skills, agents, hooks, and commands that work together</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="composeWorkflowBtn" title="Check whether your goal is achievable with the skills, agents, hooks and commands you already have">🧬 Compose from Installed</button>
        <button class="btn btn-primary" id="createWorkflowBtn">✨ Create with AI</button>
      </div>
    </div>

    <div class="wf-guide-box">
      <h4>📖 How Workflows Work</h4>
      <p>A workflow combines four types of Claude Code components into a coordinated system:
        <strong>Skills</strong> (reusable knowledge invoked via <code>/name</code>),
        <strong>Agents</strong> (specialised sub-instances with their own prompts and tool access),
        <strong>Hooks</strong> (auto-run scripts at lifecycle events like <code>PreToolUse</code> or <code>PostToolUse</code>), and
        <strong>Commands</strong> (slash-commands that trigger specific behaviours).</p>
      <p><strong>Create with AI:</strong> describe your goal → Claude generates all component files → review &amp; edit each one → install. &nbsp;
         <strong>Use pre-built:</strong> click a template below → review components → Install All.</p>
    </div>

    ${myWfHtml}
    <div class="subhead">Pre-built Templates</div>
    <div class="workflow-grid">
      ${WORKFLOWS.map(w => {
        const st = wfStatus(w);
        return `
        <div class="workflow-card" style="cursor:pointer">
          <div class="workflow-card-top" onclick="showWorkflowDetail('${w.id}')">
            <span class="workflow-card-icon">${w.icon}</span>
            <div>
              <div class="workflow-card-name">${escHtml(w.name)}
                ${st.full
                  ? '<span class="badge badge-success" style="font-size:10px;margin-left:4px">✓ installed</span>'
                  : st.n > 0
                    ? `<span class="badge badge-warning" style="font-size:10px;margin-left:4px">${st.n}/${st.total} installed</span>`
                    : ''}
              </div>
              <div class="workflow-card-tagline">${escHtml(w.tagline)}</div>
            </div>
          </div>
          <div class="workflow-card-desc" onclick="showWorkflowDetail('${w.id}')">${escHtml(w.description)}</div>
          <div class="workflow-card-badges" style="display:flex;align-items:center;justify-content:space-between;gap:6px">
            <div>${w.components.map(c => `<span class="badge ${WF_TYPE_CLASS[c.type] || 'badge-muted'}">${c.icon} ${c.type}</span>`).join('')}</div>
            <div style="display:flex;gap:5px;flex-shrink:0">
              ${st.full
                ? `<button class="btn btn-run btn-sm" data-wf-run="${w.id}" title="Run this workflow one-shot with all permissions">▶ Run</button>`
                : `<button class="btn btn-run btn-sm" disabled title="Install this workflow first — Run needs its components on disk">▶ Run</button>
                   <button class="btn btn-primary btn-sm" data-wf-card-install="${w.id}" title="Install all ${st.total} components; hooks are wired automatically">⬇ Install</button>`}
              <button class="btn btn-secondary btn-sm" data-wf-usage="${w.id}" title="How to invoke it — incl. the no-permissions one-shot command">📖 Usage</button>
              <button class="btn-explain" data-wf-explain="${w.id}" title="Explain with AI">🤖 Explain</button>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;

  document.getElementById('createWorkflowBtn').onclick = openWorkflowWizard;
  document.getElementById('composeWorkflowBtn').onclick = openComposeModal;
  // Your Workflows actions
  section.querySelectorAll('[data-mywf-run]').forEach(btn => {
    btn.onclick = () => {
      const w = myWorkflows.find(x => x.name === btn.dataset.mywfRun);
      if (w) openRunModal('workflow', w.title || w.name, buildWorkflowOneShotPrompt(w));
    };
  });
  section.querySelectorAll('[data-mywf-usage]').forEach(btn => {
    btn.onclick = () => {
      const w = myWorkflows.find(x => x.name === btn.dataset.mywfUsage);
      if (!w) return;
      document.getElementById('wfUsageTitle').textContent = '📖 ' + (w.title || w.name) + ' — how to use it';
      const body = document.getElementById('wfUsageBody');
      body.innerHTML = `
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">${escHtml(w.description || '')}</div>
        ${w.setupGuide?.length ? `<div style="font-weight:700;margin:12px 0 6px">📋 Setup</div><ol class="wf-setup-steps">${w.setupGuide.map(x => `<li>${escHtml(x)}</li>`).join('')}</ol>` : ''}
        ${buildWorkflowUsageHtml(w)}`;
      wireOneShotCopyButtons(body);
      document.getElementById('wfUsageModal').classList.add('open');
    };
  });
  section.querySelectorAll('[data-mywf-del]').forEach(btn => {
    btn.onclick = async () => {
      if (!await confirmDlg('Remove Workflow', `Remove "${btn.dataset.mywfDel}" from this list? The installed skills/agents/hooks stay in place.`)) return;
      try { await api('DELETE', '/workflows/' + encodeURIComponent(btn.dataset.mywfDel)); toast('Workflow removed'); loadWorkflows(); }
      catch (e) { toast(e.message, 'error'); }
    };
  });
  // One-click install from the card: create every component (already-exists is
  // fine), wire hooks to their events automatically, then refresh.
  section.querySelectorAll('[data-wf-card-install]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const w = WORKFLOWS.find(x => x.id === btn.dataset.wfCardInstall);
      if (!w) return;
      btn.disabled = true; btn.textContent = 'Installing…';
      let ok = 0; const failed = [];
      for (const comp of w.components) {
        try {
          try {
            await api('POST', '/' + WF_INSTALL_API[comp.type], { name: comp.name, content: comp.content });
          } catch (err) {
            if (!/exists/i.test(err.message)) throw err; // already installed = fine
          }
          if (comp.type === 'hook' && comp.event) {
            await api('POST', '/hooks/wire', { event: comp.event, matcher: comp.matcher || '', filename: comp.name });
          }
          ok++;
        } catch (err) { failed.push(`${comp.name} (${err.message.slice(0, 40)})`); }
      }
      toast(failed.length
        ? `Installed ${ok}/${w.components.length} — failed: ${failed.join(', ')}`
        : `${w.name} installed — hooks wired automatically. ▶ Run is now enabled.`,
        failed.length ? 'error' : 'success');
      loadWorkflows();
    };
  });

  // Pre-built template usage (incl. copyable no-permissions one-shot command)
  section.querySelectorAll('[data-wf-usage]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const w = WORKFLOWS.find(x => x.id === btn.dataset.wfUsage);
      if (!w) return;
      const wfLike = {
        name: w.id, title: w.name, description: w.description,
        components: w.components.map(c => ({ type: c.type, name: c.name.replace(/\.(mjs|js|py|sh)$/, ''), description: c.desc, event: c.event, matcher: c.matcher })),
      };
      document.getElementById('wfUsageTitle').textContent = '📖 ' + w.name + ' — how to use it';
      const body = document.getElementById('wfUsageBody');
      body.innerHTML = `
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">${escHtml(w.description)}</div>
        ${buildWorkflowUsageHtml(wfLike)}`;
      wireOneShotCopyButtons(body);
      document.getElementById('wfUsageModal').classList.add('open');
    };
  });
  section.querySelectorAll('[data-wf-run]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const w = WORKFLOWS.find(x => x.id === btn.dataset.wfRun);
      if (!w) return;
      openRunModal('workflow', w.name, `${w.description}\n\nUse these installed components where relevant: ${w.components.map(c => c.type + ' "' + c.name + '"').join(', ')}.`);
    };
  });
  section.querySelectorAll('[data-wf-explain]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const w = WORKFLOWS.find(x => x.id === btn.dataset.wfExplain);
      if (!w) return;
      const content = `Workflow: ${w.name}\n${w.description}\n\nComponents:\n${w.components.map(c => `- ${c.type}: ${c.name} — ${c.description}`).join('\n')}\n\nFlow:\n${w.flowSteps.map(s => s.text).join(' → ')}`;
      showExplainer(w.name, content, 'workflow');
    };
  });
}

function showWorkflowDetail(id) {
  const w = WORKFLOWS.find(x => x.id === id);
  if (!w) return;
  const section = document.getElementById('section-workflows');
  section.innerHTML = `
    <div style="margin-bottom:4px">
      <button class="btn btn-ghost btn-sm" onclick="loadWorkflows()">← All Workflows</button>
    </div>
    <div class="section-header" style="margin-bottom:20px">
      <div>
        <div class="section-title">${w.icon} ${escHtml(w.name)}</div>
        <div class="section-subtitle">${escHtml(w.tagline)}</div>
      </div>
      <button class="btn btn-primary" id="wf-install-all">⬇ Install All (${w.components.length})</button>
    </div>
    <p style="color:var(--text-muted);margin-bottom:24px;font-size:14px">${escHtml(w.description)}</p>

    <div class="wf-flow-box">
      <div class="wf-section-label">How it works</div>
      <div class="wf-flow-steps">
        ${w.flowSteps.map((s, i) => `
          <div class="wf-flow-step"><div class="wf-flow-icon">${s.icon}</div><div class="wf-flow-text">${escHtml(s.text)}</div></div>
          ${i < w.flowSteps.length - 1 ? '<div class="wf-flow-arrow">›</div>' : ''}
        `).join('')}
      </div>
    </div>

    <div class="wf-section-label" style="margin:20px 0 10px">Components (${w.components.length})</div>
    <div id="wf-components-list">
      ${w.components.map((comp, i) => `
        <div class="wf-component-row" id="wf-comp-${i}">
          <div class="wf-comp-left">
            <span style="font-size:20px">${comp.icon}</span>
            <div>
              <div class="wf-comp-title">
                <span class="badge ${WF_TYPE_CLASS[comp.type] || 'badge-muted'}" style="text-transform:capitalize">${comp.type}</span>
                <code>${escHtml(comp.name)}</code>
                ${comp.event ? `<span class="wf-comp-meta">${escHtml(comp.event)}${comp.matcher ? ' · matcher: <code>' + escHtml(comp.matcher) + '</code>' : ''}</span>` : ''}
              </div>
              <div class="wf-comp-desc">${escHtml(comp.desc)}</div>
            </div>
          </div>
          <div class="wf-comp-actions">
            <button class="btn btn-xs btn-ghost" onclick="wfTogglePreview(${i})">Preview</button>
            <button class="btn btn-xs btn-secondary" id="wf-btn-${i}" onclick="wfInstallOne(${i},'${w.id}')">Create</button>
            ${comp.type === 'hook' ? `<button class="btn btn-xs btn-ghost" onclick="wfRegisterHook(${i},'${w.id}')">Register</button>` : ''}
          </div>
          <pre class="wf-comp-preview" id="wf-preview-${i}" style="display:none">${escHtml(comp.content)}</pre>
        </div>
      `).join('')}
    </div>

    <div class="wf-guide">
      <div class="wf-section-label" style="margin-bottom:10px">Setup guide</div>
      <ol class="wf-guide-steps">
        <li>Click <strong>Install All</strong> to create all component files in your .claude folder.</li>
        ${w.components.filter(c => c.type === 'hook').map(c =>
          `<li>Click <strong>Register</strong> on <code>${escHtml(c.name)}</code> → pick event <code>${escHtml(c.event)}</code>${c.matcher ? ', matcher <code>' + escHtml(c.matcher) + '</code>' : ''} → Save.</li>`
        ).join('')}
        <li>Start a new Claude Code session to activate any SessionStart hooks.</li>
        <li>Test by triggering the relevant skill, command, or workflow action.</li>
      </ol>
    </div>`;

  document.getElementById('wf-install-all').onclick = () => wfInstallAll(w.id);
}

window.wfTogglePreview = function(i) {
  const el = document.getElementById('wf-preview-' + i);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
};

window.wfInstallOne = async function(i, workflowId) {
  const w = WORKFLOWS.find(x => x.id === workflowId);
  if (!w) return;
  const comp = w.components[i];
  if (!comp.name?.trim()) { toast(`Component ${i + 1} has no name — skipping`, 'error'); return; }
  if (!comp.content?.trim()) { toast(`${comp.name} has no content — skipping`, 'error'); return; }
  const btn  = document.getElementById('wf-btn-' + i);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    if (comp.type === 'skill')   await api('POST', '/skills',      { name: comp.name, content: comp.content });
    if (comp.type === 'agent')   await api('POST', '/agents',      { name: comp.name, content: comp.content });
    if (comp.type === 'command') await api('POST', '/commands',    { name: comp.name, content: comp.content });
    if (comp.type === 'hook')    await api('POST', '/hooks/files', { name: comp.name, content: comp.content });
    if (btn) {
      btn.textContent = '✓ Done'; btn.disabled = true;
      btn.classList.remove('btn-secondary'); btn.classList.add('btn-success');
    }
    // Hooks: wire automatically when the template declares the event;
    // only fall back to a manual Register button when it doesn't.
    if (comp.type === 'hook') {
      if (comp.event) {
        try {
          await api('POST', '/hooks/wire', { event: comp.event, matcher: comp.matcher || '', filename: comp.name });
          toast(`${comp.name} created & wired to ${comp.event}${comp.matcher ? ' (' + comp.matcher + ')' : ''}`, 'success');
        } catch (e2) {
          toast(`${comp.name} created — automatic wiring failed (${e2.message}), use "Register to event"`, 'error');
          comp._needsManualWire = true;
        }
      }
      if (!comp.event || comp._needsManualWire) {
        const row = document.getElementById('wf-btn-' + i)?.closest('.wf-review-card, .wf-install-row');
        if (row && !row.querySelector('.wf-register-btn')) {
          const regBtn = document.createElement('button');
          regBtn.className = 'btn btn-xs btn-warning wf-register-btn';
          regBtn.textContent = '🔗 Register to event';
          regBtn.onclick = () => window.wfRegisterHook(i, workflowId);
          btn?.insertAdjacentElement('afterend', regBtn);
        }
        if (!comp.event) toast(`${comp.name} created — click "Register to event" to wire it`, 'success');
      }
    } else {
      toast(comp.name + ' created');
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Create'; }
    toast(`Failed to create ${comp.name}: ${e.message || 'unknown error'}`, 'error');
    throw e;
  }
};

window.wfRegisterHook = function(i, workflowId) {
  const w    = WORKFLOWS.find(x => x.id === workflowId);
  if (!w) return;
  const comp = w.components[i];
  if (comp.type !== 'hook') return;
  const folder   = document.getElementById('folderPath').textContent;
  const fullPath = folder + '/hooks/' + comp.name;
  showHookAddModal(comp.event || null, fullPath, 'Register: ' + comp.name, -1, comp.matcher || '');
};

window.wfInstallAll = async function(workflowId) {
  const w   = WORKFLOWS.find(x => x.id === workflowId);
  if (!w) return;
  const btn = document.getElementById('wf-install-all');
  if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  let ok = 0; const failed = [];
  for (let i = 0; i < w.components.length; i++) {
    try { await window.wfInstallOne(i, workflowId); ok++; }
    catch { failed.push(w.components[i]?.name || `#${i+1}`); }
  }
  if (btn) { btn.disabled = false; btn.textContent = '⬇ Install All (' + w.components.length + ')'; }
  const hookCount = w.components.filter(c => c.type === 'hook').length;
  const summary = `Installed ${ok}/${w.components.length}`
    + (failed.length ? ` — failed: ${failed.join(', ')}` : '')
    + (hookCount ? ` — wire ${hookCount} hook${hookCount > 1 ? 's' : ''} to lifecycle events using the Register buttons` : '');
  toast(summary, failed.length ? 'error' : 'success');
};

window.loadWorkflows      = loadWorkflows;
window.showWorkflowDetail = showWorkflowDetail;
window.openWorkflowWizard = openWorkflowWizard;

// Close any open ⋯ menus when clicking elsewhere (native details doesn't)
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.more-menu[open]').forEach(d => {
    if (!d.contains(e.target)) d.removeAttribute('open');
  });
});

// ===== BOOT =====
checkFolderValid();
loadBadges();
loadOverview();
