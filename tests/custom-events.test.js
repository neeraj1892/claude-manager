'use strict';
// Custom (derived) events: AI-designed detectors bound to real Claude Code
// events — designed, installed (script + wiring + registry), listed, deleted.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { startServer } = require('./helper');

let s;
before(async () => { s = await startServer(4700); });
after(() => s.stop());

let def;

test('AI design: returns a validated custom-event definition', async () => {
  const { status, data } = await s.api('POST', '/ai/create-custom-event', {
    description: 'whenever Claude runs a git push', action: 'block it', provider: 'claude-cli',
  });
  assert.equal(status, 200, JSON.stringify(data));
  def = data;
  assert.equal(def.name, 'GitPushDetected');
  assert.equal(def.underlyingEvent, 'PreToolUse', 'underlying event is a real Claude Code event');
  assert.equal(def.matcher, 'Bash');
  assert.match(def.filename, /^[a-z0-9-]+\.mjs$/);
  assert.ok(def.hookScript.startsWith('#!'), 'script has shebang');
  assert.ok(def.hookScript.includes('CUSTOM EVENT GitPushDetected'), 'script self-documents the event');
  assert.ok(def.how, 'explains how it works');
  // Prompt teaches the derived-event concept and lists real events
  const prompt = s.readShimPrompt();
  assert.ok(prompt.includes('derived event'), 'methodology explains derivation');
  assert.ok(prompt.includes('PreToolUse') && prompt.includes('FileChanged'), 'all real events offered');
});

test('AI design validation: description required', async () => {
  assert.equal((await s.api('POST', '/ai/create-custom-event', {})).status, 400);
});

test('language choice: prompt teaches the chosen language, filename coerced to its extension', async () => {
  const py = await s.api('POST', '/ai/create-custom-event', {
    description: 'whenever Claude runs a git push', provider: 'claude-cli', lang: '.py',
  });
  assert.equal(py.status, 200);
  assert.ok(py.data.filename.endsWith('.py'), 'filename coerced to .py: ' + py.data.filename);
  assert.equal(py.data.lang, '.py');
  assert.ok(s.readShimPrompt().includes('Python 3 (.py)'), 'Python rules in the design prompt');

  const sh = await s.api('POST', '/ai/create-custom-event', {
    description: 'whenever Claude runs a git push', provider: 'claude-cli', lang: '.sh',
  });
  assert.ok(sh.data.filename.endsWith('.sh'));
  assert.ok(s.readShimPrompt().includes('Bash (.sh)'));

  // unknown lang falls back to .mjs
  const bad = await s.api('POST', '/ai/create-custom-event', {
    description: 'x', provider: 'claude-cli', lang: '.exe',
  });
  assert.equal(bad.data.lang, '.mjs');
});

test('install: PowerShell hooks are wired with pwsh; response carries the settings snippet', async () => {
  const r = await s.api('POST', '/custom-events/install', {
    name: 'PwshEvent', description: 'd', underlyingEvent: 'PostToolUse', matcher: 'Bash',
    filename: 'pwsh-event.ps1', hookScript: '# CUSTOM EVENT PwshEvent\nexit 0', how: 'h',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.command.startsWith('pwsh '), 'ps1 wired with pwsh runner: ' + r.data.command);
  assert.ok(r.data.settingsSnippet.hooks.PostToolUse, 'settings snippet returned for the done screen');
  await s.api('DELETE', '/custom-events/PwshEvent');
});

test('install: writes the script, wires settings.json, records the registry', async () => {
  const { status, data } = await s.api('POST', '/custom-events/install', def);
  assert.equal(status, 201, JSON.stringify(data));
  assert.match(data.wiredTo, /PreToolUse \(matcher: Bash\)/);

  // script on disk
  const file = join(s.claudeDir, 'hooks', def.filename);
  assert.ok(existsSync(file));
  assert.ok(readFileSync(file, 'utf8').startsWith('#!'));

  // wired in settings.json under the underlying event with the right matcher
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  const group = settings.hooks.PreToolUse.find(g => g.matcher === 'Bash');
  assert.ok(group, 'matcher group created');
  assert.ok(group.hooks.some(h => h.command.includes(def.filename)), 'command registered');

  // registry entry visible with live status
  const list = await s.api('GET', '/custom-events');
  const ev = list.data.find(e => e.name === 'GitPushDetected');
  assert.ok(ev, 'listed');
  assert.equal(ev.fileExists, true);
  assert.equal(ev.wired, true);
  assert.equal(ev.description, def.description);
});

test('install validation: bad name / unknown event / duplicate -> 4xx', async () => {
  assert.equal((await s.api('POST', '/custom-events/install', { ...def, name: 'not-camel' })).status, 400);
  assert.equal((await s.api('POST', '/custom-events/install', { ...def, name: 'OtherName', underlyingEvent: 'FakeEvent' })).status, 400);
  assert.equal((await s.api('POST', '/custom-events/install', { ...def, name: 'OtherName', filename: '../evil.mjs' })).status, 400);
  assert.equal((await s.api('POST', '/custom-events/install', def)).status, 409, 'duplicate name rejected');
});

test('delete: unwires settings.json, removes script and registry entry', async () => {
  const { status } = await s.api('DELETE', '/custom-events/GitPushDetected');
  assert.equal(status, 200);
  assert.ok(!existsSync(join(s.claudeDir, 'hooks', def.filename)), 'script removed');
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.ok(!JSON.stringify(settings.hooks || {}).includes(def.filename), 'unwired');
  const list = await s.api('GET', '/custom-events');
  assert.equal(list.data.length, 0);
  assert.equal((await s.api('DELETE', '/custom-events/GitPushDetected')).status, 404);
});

test('delete preserves other hooks sharing the same event/matcher', async () => {
  // Wire an unrelated hook on the same event+matcher, then install/delete a custom event
  await s.api('PUT', '/hooks/settings', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node keep-me.mjs' }] }] } });
  await s.api('POST', '/custom-events/install', def);
  await s.api('DELETE', '/custom-events/GitPushDetected');
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  const group = settings.hooks.PreToolUse.find(g => g.matcher === 'Bash');
  assert.ok(group.hooks.some(h => h.command === 'node keep-me.mjs'), 'unrelated hook untouched');
  assert.ok(!group.hooks.some(h => h.command.includes(def.filename)), 'custom event hook removed');
});
