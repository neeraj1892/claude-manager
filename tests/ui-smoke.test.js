'use strict';
// UI smoke tests: load index.html + app.js in jsdom, exercise key flows, and
// verify the requests the frontend actually sends. Catches frontend/backend
// contract drift (wrong field names, missing providers) that API tests can't.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('fs');
const { join } = require('path');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch {}

const ROOT = join(__dirname, '..');
let w, sent;

before(async (t) => {
  if (!JSDOM) return; // dependency missing — tests below will skip
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  w = dom.window;
  w.require = Object.assign(function () {}, { config() {} }); // Monaco AMD stub
  w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
  w.navigator.clipboard = { writeText: async (t) => { w._lastClip = t; } };
  sent = [];
  w.fetch = async (path, opts) => {
    sent.push({ path, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : undefined });
    return { ok: true, status: 200, json: async () => {
      if (path.includes('/ai/generate-skill')) return { content: '#!/usr/bin/env node\n// ok', type: 'hook' };
      if (path.includes('/status')) return { valid: true, path: '/x', platform: 'darwin' };
      if (path.includes('/keybindings')) return { content: '', exists: false };
      if (path.includes('/ai-config')) return { claudeCli: true, hasOpenRouterKey: true, openRouterModel: 'anthropic/claude-sonnet-4-5' };
      if (path.includes('/hook-events')) return { builtin: [], dynamic: [], all: [] };
      if (path.includes('/custom-events')) return [];
      if (path.includes('/settings/inspect')) return { files: [] };
      if (path.includes('/overview')) return { skills: 1, agents: 2, hookEvents: 3, plugins: 4, enabledPlugins: 2, mcpServers: 5, commands: 6, hookFiles: 0, model: 'default', path: '/x' };
      if (path.includes('/hooks')) return { files: [], elsewhere: [], settings: {} };
      if (path.includes('/workflows')) return [];
      if (path.includes('/skills/demo-skill')) return { name: 'demo-skill', content: '---\nname: demo-skill\n---\n\nRaw skill body.' };
      if (path.endsWith('/api/skills')) return [{ name: 'demo-skill', description: 'demo', size: '1 KB', modified: new Date().toISOString() }];
      return [];
    } };
  };
  w.eval(readFileSync(join(ROOT, 'public/app.js'), 'utf8'));
});

const skipIfNoDom = (t) => { if (!JSDOM || !w) { t.skip('jsdom not installed'); return true; } return false; };

test('app.js loads without top-level errors (all wired elements exist)', (t) => {
  if (skipIfNoDom(t)) return;
  assert.ok(w.document.getElementById('kbContext'), 'DOM alive after full script eval');
});

test('Add-Hook inline generator sends the correct request contract', async (t) => {
  if (skipIfNoDom(t)) return;
  w.document.getElementById('hookGenDesc').value = 'log every bash command';
  await w.eval('runHookGenInModal()');
  const req = sent.find(s => s.path.includes('/ai/generate-skill'));
  assert.ok(req, 'generate request sent');
  assert.equal(req.body.prompt, 'log every bash command', 'uses the required "prompt" field');
  assert.equal(req.body.type, 'hook');
  assert.match(req.body.hookLang, /^\.(mjs|py|sh)$/, 'hookLang carries its dot: ' + req.body.hookLang);
  assert.ok(req.body.provider, 'provider always sent');
  assert.equal(w.document.getElementById('hookGenPreview').style.display, '', 'preview shown on success');
});

test('Add-Hook generator has an OpenRouter provider with key + model fields', async (t) => {
  if (skipIfNoDom(t)) return;
  await w.eval("setHookGenProvider('openrouter')");
  await new Promise(r => setTimeout(r, 30));
  assert.equal(w.document.getElementById('hgOrConfig').style.display, '', 'OR config visible');
  assert.ok(w.document.getElementById('hgOrModel').options.length >= 5, 'model choices offered');
  assert.match(w.document.getElementById('hgOrKeyStatus').textContent, /key saved/, 'saved-key status shown');
});

test('every provider-capable modal exposes an OpenRouter config block', (t) => {
  if (skipIfNoDom(t)) return;
  for (const id of ['runOrConfig', 'composeOrConfig', 'ceOrConfig', 'hgOrConfig', 'orInlineConfig']) {
    assert.ok(w.document.getElementById(id), 'missing OR config block: ' + id);
  }
});

test('overview: concept map + getting-started render, nav order Build-first', async (t) => {
  if (skipIfNoDom(t)) return;
  assert.equal(w.document.querySelectorAll('.ov-concept').length, 6, 'six concept cards');
  assert.equal(w.document.querySelectorAll('.ov-start').length, 4, 'four getting-started moves');
  const order = [...w.document.querySelectorAll('#sidebar .nav-item')].map(b => b.dataset.section);
  assert.deepEqual(order, ['overview', 'skills', 'agents', 'hooks', 'commands', 'workflows', 'plugins', 'claude-md', 'settings', 'keybindings', 'examples'],
    'workflows follows commands; keybindings and examples in separate groups');
});

test('manual command respects the shell toggle (bash heredoc vs PowerShell here-string)', async (t) => {
  if (skipIfNoDom(t)) return;
  await w.eval("openRunModal('skill','demo-skill')");
  await new Promise(r => setTimeout(r, 80));
  w.eval("setShellPref('bash'); refreshManualRunCmd()");
  let cmd = w.document.getElementById('runManualCmd').value;
  assert.ok(cmd.includes("<< 'PROMPT'"), 'bash uses heredoc');
  assert.ok(cmd.startsWith('cd '), 'bash includes cd');
  w.eval("setShellPref('powershell'); refreshManualRunCmd()");
  cmd = w.document.getElementById('runManualCmd').value;
  assert.ok(cmd.includes("@'"), 'PowerShell here-string');
  assert.ok(cmd.includes('Out-File -Encoding utf8'), 'PowerShell-safe redirect');
  assert.ok(cmd.includes('$HOME'), '~ paths translated for PowerShell');
  assert.ok(!cmd.includes('<< '), 'no heredoc leaks into PS');
  w.eval("setShellPref('bash')");
});

test('shell default follows the CLIENT OS (terminal is on the browser machine)', (t) => {
  if (skipIfNoDom(t)) return;
  const d = w.deriveShellDefault;
  assert.equal(d('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'linux'), 'powershell',
    'Windows browser + linux/mac server → PowerShell (the reported bug)');
  assert.equal(d('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'win32'), 'bash');
  assert.equal(d('Mozilla/5.0 (X11; Linux x86_64)', 'win32'), 'bash');
  assert.equal(d('', 'win32'), 'powershell', 'unknown UA falls back to server platform');
  assert.equal(d('', 'darwin'), 'bash');
});

test('manual command: output dir created, heredoc delimiter collision-proof', (t) => {
  if (skipIfNoDom(t)) return;
  let cmd = w.eval(`buildBashCommand(['/plan x', 'body'], '~', '~/claude-runs/out.jsonl', '')`);
  assert.ok(cmd.includes('mkdir -p ~/claude-runs'), 'bash creates the output dir');
  assert.ok(cmd.includes("<< 'PROMPT'"), 'default delimiter when no collision');
  cmd = w.eval(`buildBashCommand(['line one', 'PROMPT', 'line three'], '~', 'out.jsonl', '')`);
  assert.ok(!cmd.includes("<< 'PROMPT'\n"), 'delimiter renamed when the prompt contains a PROMPT line');
  const delim = cmd.match(/<< '([^']+)'/)[1];
  assert.ok(delim.startsWith('PROMPT_END_'), 'collision-safe delimiter: ' + delim);
  assert.ok(cmd.trimEnd().endsWith('\n' + delim), 'heredoc still closed with the same delimiter');
  assert.ok(!cmd.includes('mkdir'), 'no mkdir for a bare filename');
  const ps = w.eval(`buildPsCommand(["a", "'@", "b"], '~', '~/claude-runs/out.jsonl', '')`);
  assert.ok(ps.includes('New-Item -ItemType Directory -Force'), 'PowerShell creates the output dir');
  assert.ok(ps.includes("\n '@\n"), "literal '@ line indented so the here-string survives");
});

test('workflow templates: Run disabled + Install shown until components exist', async (t) => {
  if (skipIfNoDom(t)) return;
  await w.eval('loadWorkflows()');
  await new Promise(r => setTimeout(r, 50));
  const card = w.document.querySelector('#section-workflows .workflow-card');
  assert.ok(card, 'template cards rendered');
  const run = card.querySelector('.btn-run');
  assert.ok(run.disabled, 'Run disabled when workflow not installed');
  assert.ok(run.title.toLowerCase().includes('install'), 'disabled Run explains why');
  assert.ok(card.querySelector('[data-wf-card-install]'), 'Install button present on the card');
});

test('cards: primary actions visible, secondary behind a ⋯ menu; subheads mark sections', async (t) => {
  if (skipIfNoDom(t)) return;
  await w.eval('loadSkills()');
  await new Promise(r => setTimeout(r, 30));
  const card = w.document.querySelector('#skills-grid .skill-card');
  assert.ok(card, 'skill card rendered');
  const visibleBtns = card.querySelectorAll('.skill-card-actions > .btn');
  assert.ok(visibleBtns.length <= 2, 'at most Run + Edit on the card face, got ' + visibleBtns.length);
  const menu = card.querySelector('details.more-menu');
  assert.ok(menu, '⋯ overflow menu present');
  assert.ok(menu.querySelector('[data-del]'), 'Delete lives in the menu');
  assert.ok(menu.querySelector('[data-explain]'), 'Explain lives in the menu');
  assert.ok(w.document.querySelectorAll('.subhead').length >= 2, 'subsection headers present');
});

test('lists render as one container; hook rows SHOW wired state (DOET visibility)', async (t) => {
  if (skipIfNoDom(t)) return;
  w.eval(`renderHookFiles(
    [{ name: 'a.mjs', size: '1 KB', modified: new Date().toISOString(), content: '' },
     { name: 'b.py',  size: '2 KB', modified: new Date().toISOString(), content: '' }],
    { 'a.mjs': new Set(['PreToolUse']) })`);
  const list = w.document.querySelector('#hook-files-list .list');
  assert.ok(list, 'single .list container (not stacked cards)');
  const rows = list.querySelectorAll('.list-row');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /● PreToolUse/, 'wired file shows its event');
  assert.match(rows[1].textContent, /○ not wired/, 'unwired file states it plainly');
  assert.ok(rows[1].querySelector('[data-hf-wire]'), 'unwired file offers a one-click Wire action');
  assert.ok(!rows[0].querySelector('[data-hf-wire]'), 'wired file does not nag');
  list.querySelectorAll('.icon-act').forEach(a => assert.ok(a.title, 'every icon action has a tooltip'));
});

test('cards offer ⧉ Copy content — copies the exact raw file to the clipboard', async (t) => {
  if (skipIfNoDom(t)) return;
  await w.eval('loadSkills()');
  await new Promise(r => setTimeout(r, 30));
  const btn = w.document.querySelector('#skills-grid .skill-card details.more-menu [data-copy]');
  assert.ok(btn, '⋯ menu contains a Copy content action');
  w._lastClip = null;
  btn.onclick();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(w._lastClip, '---\nname: demo-skill\n---\n\nRaw skill body.', 'clipboard got the exact file content');
});

test('hook file rows offer ⧉ copy (raw script content)', async (t) => {
  if (skipIfNoDom(t)) return;
  w.eval(`renderHookFiles([{ name: 'c.mjs', size: '1 KB', modified: new Date().toISOString(), content: '#!/usr/bin/env node\\n// hook body' }], {})`);
  const btn = w.document.querySelector('#hook-files-list [data-hf-copy]');
  assert.ok(btn, 'copy action present on hook file row');
  w._lastClip = null;
  btn.onclick();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(w._lastClip, '#!/usr/bin/env node\n// hook body', 'clipboard got the exact script');
});

test('workflow usage: per-component copy, but no copy of the whole workflow', async (t) => {
  if (skipIfNoDom(t)) return;
  w.eval(`
    const el = document.getElementById('wfUsageBody');
    el.innerHTML = buildWorkflowUsageHtml({ name: 'test-wf', components: [
      { type: 'skill', name: 'comp-skill', content: 'SKILL RAW' },
      { type: 'hook',  name: 'guard-hook', event: 'PreToolUse', content: 'HOOK RAW' },
    ]});
    wireOneShotCopyButtons(el);
  `);
  const body = w.document.getElementById('wfUsageBody');
  const btns = body.querySelectorAll('[data-copy-comp]');
  assert.equal(btns.length, 2, 'one copy per component');
  assert.ok(!body.querySelector('[data-copy="test-wf"]'), 'no whole-workflow content copy');
  w._lastClip = null;
  btns[0].onclick();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(w._lastClip, 'SKILL RAW', 'component content copied verbatim');
});

test('elsewhere + file-explorer rows expose ⧉ copy', (t) => {
  if (skipIfNoDom(t)) return;
  w.eval(`renderElsewhereHooks([{ path: 'skills/x/hooks/h.mjs', size: '1 KB', modified: new Date().toISOString() }])`);
  assert.ok(w.document.querySelector('#hook-elsewhere-wrap [data-ew-copy]'), 'elsewhere rows have copy');
  assert.equal(typeof w.copyFileByPath, 'function', 'shared path-copy helper exists');
});

test('keybindings + hooks subtabs render (regression)', async (t) => {
  if (skipIfNoDom(t)) return;
  await w.eval('loadKeybindings()');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(w.document.getElementById('kbContext').options.length, 19, 'all 19 contexts');
  await w.eval('loadHooks()');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(w.document.querySelectorAll('#hookSubtabs .hook-subtab').length, 4);
});
