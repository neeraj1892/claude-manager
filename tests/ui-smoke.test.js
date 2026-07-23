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
      if (path.includes('/lint/resolve')) return { ok: true, changed: true, added: ['Edit'], lint: { missing: [], unused: [], suggestions: [] } };
      if (path.includes('/skills/demo-skill')) return { name: 'demo-skill', content: '---\nname: demo-skill\n---\n\nRaw skill body.' };
      if (path.endsWith('/api/skills')) return [{ name: 'demo-skill', description: 'demo', size: '1 KB', modified: new Date().toISOString(), lint: { missing: ['Edit'], unused: [], suggestions: [] } }];
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
  assert.ok(cmd.startsWith("mkdir -p 'claude-runs' && claude -p"), 'no cd by default — runs in the current folder: ' + cmd.split('\n')[0]);
  w.document.getElementById('runCwd').value = '~/proj';
  w.eval('refreshManualRunCmd()');
  cmd = w.document.getElementById('runManualCmd').value;
  assert.ok(cmd.startsWith('cd ~/proj && '), 'explicit working directory still gets a cd');
  w.document.getElementById('runCwd').value = '';
  w.eval("setShellPref('powershell'); refreshManualRunCmd()");
  cmd = w.document.getElementById('runManualCmd').value;
  assert.ok(cmd.includes("@'"), 'PowerShell here-string');
  assert.ok(cmd.includes('Out-File -Encoding utf8'), 'PowerShell-safe redirect');
  assert.ok(!cmd.startsWith('cd '), 'no cd by default in PS either');
  w.document.getElementById('runCwd').value = '~/proj';
  w.eval('refreshManualRunCmd()');
  cmd = w.document.getElementById('runManualCmd').value;
  assert.ok(cmd.includes('$HOME'), '~ paths translated for PowerShell');
  w.document.getElementById('runCwd').value = '';
  w.eval('refreshManualRunCmd()');
  cmd = w.document.getElementById('runManualCmd').value;
  assert.ok(!cmd.includes('<< '), 'no heredoc leaks into PS');
  w.eval("setShellPref('bash')");
});

test('portable command: one string valid in bash+zsh+PowerShell; honest refusal on apostrophes', (t) => {
  if (skipIfNoDom(t)) return;
  const cmd = w.eval(`buildPortableCommand(['/plan x', 'line two'], '~', 'claude-runs/out.jsonl', 'sonnet')`);
  assert.ok(cmd.startsWith('cd ~ ; mkdir -p claude-runs ; claude -p '),
    'cd BEFORE mkdir so a relative output dir lands in the working directory');
  const noCwd = w.eval(`buildPortableCommand(['/plan x'], '', 'claude-runs/out.jsonl', '')`);
  assert.ok(noCwd.startsWith('mkdir -p claude-runs ; claude -p '), 'blank cwd → no cd, runs in the current folder');
  assert.ok(cmd.includes("'/plan x\nline two'"), 'prompt is a single-quoted literal (identical semantics in all three)');
  assert.ok(cmd.includes('--model sonnet'), 'model pin carried');
  assert.ok(!cmd.includes('<<') && !cmd.includes('\\\n') && !cmd.includes('`'), 'no heredoc, no bash/PS-only continuations');
  const refused = w.eval(`buildPortableCommand(["the user's plan"], '~', 'x.jsonl', '')`);
  assert.ok(refused.startsWith('#') && refused.includes('apostrophe'), 'apostrophe prompt refused with an explanation, not a broken command');
  const spacey = w.eval(`buildPortableCommand(['x'], '~/My Folder', 'x.jsonl', '')`);
  assert.ok(spacey.startsWith('#'), 'paths with spaces refused too');
  assert.ok(w.document.querySelector('[data-shell-pick="portable"]'), 'Portable chip present in the modal');
});

test('REGRESSION: computed shell default never persists; only explicit clicks do', async (t) => {
  if (skipIfNoDom(t)) return;
  w.localStorage.setItem('cm-shell', 'bash'); // stale legacy auto-written key (the reported bug)
  w.eval("setShellPref('powershell')");       // computed/sync call — no persist arg
  assert.equal(w.localStorage.getItem('cm-shell-v2'), null,
    'auto-derived pref must not be written — stale values froze Windows users on bash');
  const chip = w.document.querySelector('[data-shell-pick="powershell"]');
  chip.onclick();                             // explicit user choice
  assert.equal(w.localStorage.getItem('cm-shell-v2'), 'powershell', 'explicit click persists to the v2 key');
  w.localStorage.removeItem('cm-shell-v2');
  w.eval("setShellPref('bash')");
});

test('shell default is Portable — no OS detection can know the paste target', (t) => {
  if (skipIfNoDom(t)) return;
  assert.equal(w.deriveShellDefault(), 'portable');
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

test('REGRESSION: Improve on a card fetches the real file (lists are metadata-only)', async (t) => {
  if (skipIfNoDom(t)) return;
  await w.eval('loadSkills()');
  await new Promise(r => setTimeout(r, 30));
  const btn = w.document.querySelector('#skills-grid .skill-card [data-improve]');
  assert.ok(btn, 'Improve action present');
  btn.onclick();
  await new Promise(r => setTimeout(r, 30));
  assert.ok(w.document.getElementById('improveModal').classList.contains('open'), 'modal opened');
  assert.match(w.document.getElementById('improveModalTitle').textContent, /demo-skill/);
  await w.document.getElementById('improveRunBtn').onclick();
  await new Promise(r => setTimeout(r, 30));
  const req = sent.filter(s => s.path.includes('/ai/improve-skill')).pop();
  assert.ok(req, 'improve request sent');
  assert.equal(req.body.content, '---\nname: demo-skill\n---\n\nRaw skill body.',
    'posts the fetched file content — was empty string → server 400');
  w.document.getElementById('improveClose').onclick();
});

test('🔧 resolve-grants button: visible on flagged cards, explains itself, calls the fixer', async (t) => {
  if (skipIfNoDom(t)) return;
  await w.eval('loadSkills()');
  await new Promise(r => setTimeout(r, 30));
  const fix = w.document.querySelector('#skills-grid .skill-card [data-resolve]');
  assert.ok(fix, 'button shown when lint.missing is non-empty');
  assert.match(fix.title, /Why this shows/, 'tooltip explains why it appears');
  assert.match(fix.title, /permission prompts/, 'tooltip explains the consequence');
  assert.match(fix.title, /Click to fix/, 'tooltip explains what clicking does');
  assert.match(fix.title, /never a blanket grant/, 'tooltip explains the Bash policy (exact rules, no blanket)');
  fix.onclick();
  await new Promise(r => setTimeout(r, 30));
  const req = sent.filter(s2 => s2.path.includes('/lint/resolve')).pop();
  assert.ok(req, 'fixer endpoint called');
  assert.equal(req.body.name, 'demo-skill');
});

test('generate modal exposes model choice + opt-in bounded eval', (t) => {
  if (skipIfNoDom(t)) return;
  const sel = w.document.getElementById('sgModel');
  assert.ok(sel, 'model picker present');
  assert.equal(sel.value, 'opus', 'defaults to opus');
  assert.ok([...sel.options].some(o => o.value === 'sonnet'), 'user can pick another model');
  const cb = w.document.getElementById('sgEval');
  assert.ok(cb, 'eval opt-in present');
  assert.ok(!cb.checked, 'eval is opt-in — permission asked upfront, unchecked by default');
});

test('cards offer ⧉ Copy content — copies the exact raw file to the clipboard', async (t) => {
  if (skipIfNoDom(t)) return;
  await w.eval('loadSkills()');
  await new Promise(r => setTimeout(r, 30));
  const btn = w.document.querySelector('#skills-grid .skill-card .skill-card-actions > [data-copy]');
  assert.ok(btn, '⧉ Copy is VISIBLE on the card face next to Edit (not hidden in the ⋯ menu)');
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
