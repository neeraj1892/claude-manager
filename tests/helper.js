'use strict';
// Test helper: boots an isolated claude-manager server instance.
// - copies server.js into a temp app dir (so claude-manager.config.json is isolated)
// - symlinks node_modules
// - creates a temp claudeDir and temp HOME (so ~/.claude.json is isolated)
// - installs a fake `claude` CLI shim on PATH (records invocations, returns canned output)
const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync, chmodSync, readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { spawn } = require('child_process');

const ROOT = join(__dirname, '..');

const CLAUDE_SHIM = `#!/usr/bin/env bash
LOG="\${CLAUDE_SHIM_LOG:-/tmp/claude-shim.log}"
if [ "$1" = "--version" ]; then echo "claude 9.9.9 (test shim)"; exit 0; fi
if [ "$1" = "-p" ]; then
  ARGS="$*"
  PROMPT=$(cat)
  printf '%s' "$PROMPT" > "$LOG.prompt"
  case "$ARGS" in
    *stream-json*)
      printf '{"type":"system","subtype":"init"}\n'
      printf '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}\n'
      printf '{"type":"result","subtype":"success","result":"done"}\n'
      exit 0
      ;;
  esac
  case "$PROMPT" in
    *"custom-event designer"*)
      printf '{"name":"GitPushDetected","description":"Fires when Claude runs git push.","underlyingEvent":"PreToolUse","matcher":"Bash","filename":"git-push-detected.mjs","how":"Inspects Bash tool input for git push and blocks it.","hookScript":"#!/usr/bin/env node\\\\n// CUSTOM EVENT GitPushDetected — fires when Claude runs git push\\\\nprocess.exit(0);"}'
      ;;
    *"settings expert"*)
      printf '{"explanation":"Denies Claude access to env files.","patch":{"permissions":{"deny":["Read(.env)","Read(.env.*)"]},"model":"opus"}}'
      ;;
    *"INVENTORY OF INSTALLED RESOURCES"*)
      printf '{"feasible":"yes","summary":"Canned compose analysis.","components":[{"type":"skill","name":"compose-skill","role":"does the work"},{"type":"skill","name":"ghost-skill","role":"does not exist"}],"missing":[{"type":"hook","name":"guard-hook","description":"blocks bad commands"}],"setupGuide":["wire guard-hook to PreToolUse"]}'
      ;;
    *"workflow architect"*)
      printf '{"name":"test-workflow","title":"Test Workflow","description":"d","setupGuide":["a"],"components":[{"type":"skill","name":"comp-one","description":"d"}]}'
      ;;
    *"FENCED_TEST"*)
      printf -- '\`\`\`markdown\\n---\\nname: fenced-skill\\ndescription: was wrapped in a code fence\\n---\\n\\n# Fenced\\n\`\`\`'
      ;;
    *"hook author"*)
      printf '#!/usr/bin/env node\\nimport readline from "readline";\\n// canned hook\\n'
      ;;
    *)
      printf -- '---\\nname: generated-skill\\ndescription: canned test output\\n---\\n\\n# Generated Skill\\n\\n1. Step one.\\n'
      ;;
  esac
  exit 0
fi
echo "claude $*" >> "$LOG"
case "$*" in
  *" dupe "*|*" dupe") echo "MCP server dupe already exists in local config" >&2; exit 1;;
  *"plugin uninstall ghost-plugin"*) echo "Error: Plugin not found: ghost-plugin" >&2; exit 1;;
esac
echo "ok: claude $*"
exit 0
`;

async function startServer(port, { seedSkillCreator = false, env: extraEnv = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cm-test-'));
  const appDir = join(root, 'app');
  const claudeDir = join(root, 'claude');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  [appDir, claudeDir, home, bin].forEach(d => mkdirSync(d, { recursive: true }));

  copyFileSync(join(ROOT, 'server.js'), join(appDir, 'server.js'));
  symlinkSync(join(ROOT, 'node_modules'), join(appDir, 'node_modules'), 'dir');

  const shimLog = join(root, 'claude-shim.log');
  writeFileSync(join(bin, 'claude'), CLAUDE_SHIM);
  chmodSync(join(bin, 'claude'), 0o755);

  if (seedSkillCreator) {
    mkdirSync(join(claudeDir, 'skills', 'skill-creator'), { recursive: true });
    writeFileSync(join(claudeDir, 'skills', 'skill-creator', 'SKILL.md'),
      '---\nname: skill-creator\ndescription: REAL INSTALLED OFFICIAL CREATOR\n---\n\nInstalled methodology body.\n\nRequest: ');
  }

  const child = spawn(process.execPath, ['server.js', claudeDir], {
    cwd: appDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOME: home,
      PATH: bin + ':' + process.env.PATH,
      CLAUDE_SHIM_LOG: shimLog,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', d => logs += d);
  child.stderr.on('data', d => logs += d);

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(base + '/api/status');
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('Server did not start on port ' + port + '\n' + logs);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  return {
    base, claudeDir, home, root, shimLog, child,
    getLogs: () => logs,
    api: async (method, path, body) => {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const r = await fetch(base + '/api' + path, opts);
      let data = null;
      try { data = await r.json(); } catch {}
      return { status: r.status, data };
    },
    readShimLog: () => existsSync(shimLog) ? readFileSync(shimLog, 'utf8') : '',
    readShimPrompt: () => existsSync(shimLog + '.prompt') ? readFileSync(shimLog + '.prompt', 'utf8') : '',
    stop: () => {
      child.kill();
      try { rmSync(root, { recursive: true, force: true }); } catch {}
    },
  };
}

module.exports = { startServer };
