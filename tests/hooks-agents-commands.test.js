'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { statSync, readFileSync } = require('fs');
const { join } = require('path');
const { startServer } = require('./helper');

let s;
before(async () => { s = await startServer(4640); });
after(() => s.stop());

// ── Hooks ──

test('hooks: empty list initially', async () => {
  const { status, data } = await s.api('GET', '/hooks');
  assert.equal(status, 200);
  assert.deepEqual(data.files, []);
});

test('hooks: create .mjs file, made executable', async () => {
  const { status } = await s.api('POST', '/hooks/files', { name: 'block-rm.mjs', content: '#!/usr/bin/env node\n// test' });
  assert.equal(status, 201);
  const mode = statSync(join(s.claudeDir, 'hooks', 'block-rm.mjs')).mode & 0o111;
  assert.ok(mode > 0, 'hook script should be executable');
});

test('hooks: invalid extension -> 400', async () => {
  const { status } = await s.api('POST', '/hooks/files', { name: 'evil.exe' });
  assert.equal(status, 400);
});

test('hooks: invalid filename chars -> 400', async () => {
  const { status } = await s.api('POST', '/hooks/files', { name: '../evil.mjs' });
  assert.equal(status, 400);
});

test('hooks: duplicate -> 409', async () => {
  const { status } = await s.api('POST', '/hooks/files', { name: 'block-rm.mjs' });
  assert.equal(status, 409);
});

test('hooks: update file content', async () => {
  const { status } = await s.api('PUT', '/hooks/files/block-rm.mjs', { content: '#!/usr/bin/env node\n// updated' });
  assert.equal(status, 200);
  const { data } = await s.api('GET', '/hooks');
  assert.match(data.files[0].content, /updated/);
});

test('hooks: wire event settings into settings.json', async () => {
  const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/block-rm.mjs' }] }] };
  const { status } = await s.api('PUT', '/hooks/settings', { hooks });
  assert.equal(status, 200);
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash');
  const { data } = await s.api('GET', '/hooks');
  assert.ok(data.settings.PreToolUse);
});

test('hooks: POST without content writes the starter template', async () => {
  const { status } = await s.api('POST', '/hooks/files', { name: 'templated.mjs' });
  assert.equal(status, 201);
  const { data } = await s.api('GET', '/hooks');
  const f = data.files.find(x => x.name === 'templated.mjs');
  assert.ok(f.content.includes('#!/usr/bin/env node'), 'template shebang present');
  assert.ok(f.content.includes('templated.mjs'), 'template mentions the filename');
  await s.api('DELETE', '/hooks/files/templated.mjs');
});

test('agents: POST without content writes a frontmatter starter', async () => {
  const { status } = await s.api('POST', '/agents', { name: 'starter-agent' });
  assert.equal(status, 201);
  const g = await s.api('GET', '/agents/starter-agent');
  assert.ok(g.data.content.startsWith('---'), 'starter has frontmatter');
  assert.ok(g.data.content.includes('starter-agent'));
  await s.api('DELETE', '/agents/starter-agent');
});

test('hooks: python and shell files accepted', async () => {
  assert.equal((await s.api('POST', '/hooks/files', { name: 'log.py' })).status, 201);
  assert.equal((await s.api('POST', '/hooks/files', { name: 'guard.sh' })).status, 201);
});

test('hooks: delete file; missing -> 404', async () => {
  assert.equal((await s.api('DELETE', '/hooks/files/guard.sh')).status, 200);
  assert.equal((await s.api('DELETE', '/hooks/files/guard.sh')).status, 404);
});

// ── Agents ──

test('agents: CRUD lifecycle', async () => {
  assert.deepEqual((await s.api('GET', '/agents')).data, []);
  const c = await s.api('POST', '/agents', { name: 'reviewer', content: '---\nname: reviewer\ndescription: reviews code\ntools: Read, Bash\n---\nBody' });
  assert.equal(c.status, 201);
  const list = await s.api('GET', '/agents');
  assert.equal(list.data[0].name, 'reviewer');
  assert.match(list.data[0].description, /reviews code/);
  const g = await s.api('GET', '/agents/reviewer');
  assert.match(g.data.content, /reviewer/);
  assert.equal((await s.api('POST', '/agents', { name: 'reviewer' })).status, 409);
  assert.equal((await s.api('POST', '/agents', { name: 'bad name!' })).status, 400);
  assert.equal((await s.api('PUT', '/agents/reviewer', { content: 'updated' })).status, 200);
  assert.equal((await s.api('DELETE', '/agents/reviewer')).status, 200);
  assert.equal((await s.api('DELETE', '/agents/reviewer')).status, 404);
});

test('agents: path traversal blocked', async () => {
  const { status } = await s.api('GET', '/agents/..%2F..%2Fsettings');
  assert.ok(status === 400 || status === 404);
});

// ── Commands ──

test('commands: CRUD lifecycle', async () => {
  assert.deepEqual((await s.api('GET', '/commands')).data, []);
  assert.equal((await s.api('POST', '/commands', { name: 'deploy', content: '# /deploy\nDeploy it.' })).status, 201);
  const list = await s.api('GET', '/commands');
  assert.equal(list.data[0].name, 'deploy');
  assert.equal((await s.api('POST', '/commands', { name: 'deploy' })).status, 409);
  assert.equal((await s.api('POST', '/commands', { name: 'bad/name' })).status, 400);
  assert.equal((await s.api('PUT', '/commands/deploy', { content: 'updated' })).status, 200);
  assert.equal((await s.api('DELETE', '/commands/deploy')).status, 200);
  assert.equal((await s.api('DELETE', '/commands/deploy')).status, 404);
});

// ── Settings / CLAUDE.md / keybindings / overview / folder ──

test('settings: get/put roundtrip; invalid body -> 400', async () => {
  assert.equal((await s.api('PUT', '/settings', { settings: { model: 'opus' } })).status, 200);
  const { data } = await s.api('GET', '/settings');
  assert.equal(data.model, 'opus');
  assert.equal((await s.api('PUT', '/settings', {})).status, 400);
});

test('CLAUDE.md: get/put roundtrip', async () => {
  const g0 = await s.api('GET', '/claude-md');
  assert.equal(g0.data.exists, false);
  assert.equal((await s.api('PUT', '/claude-md', { content: '# Global memory' })).status, 200);
  const g1 = await s.api('GET', '/claude-md');
  assert.equal(g1.data.exists, true);
  assert.match(g1.data.content, /Global memory/);
});

test('keybindings: invalid JSON -> 400, valid -> ok', async () => {
  assert.equal((await s.api('PUT', '/keybindings', { content: '{oops' })).status, 400);
  assert.equal((await s.api('PUT', '/keybindings', { content: '{"a":1}' })).status, 200);
  const { data } = await s.api('GET', '/keybindings');
  assert.equal(data.exists, true);
});

test('overview: counts reflect created artifacts', async () => {
  await s.api('POST', '/skills', { name: 'ov-skill' });
  await s.api('POST', '/agents', { name: 'ov-agent' });
  await s.api('POST', '/commands', { name: 'ov-cmd' });
  // Re-wire hook settings (the settings roundtrip test above replaces settings.json wholesale)
  await s.api('PUT', '/hooks/settings', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } });
  const { data } = await s.api('GET', '/overview');
  assert.ok(data.skills >= 1);
  assert.ok(data.agents >= 1);
  assert.ok(data.commands >= 1);
  assert.ok(data.hookFiles >= 2); // block-rm.mjs + log.py
  assert.ok(data.hookEvents >= 1); // PreToolUse wired earlier
  assert.equal(data.hasClaudeMd, true);
  assert.equal(data.hasKeybindings, true);
});

test('folder: switching to missing dir -> 404, valid dir works', async () => {
  assert.equal((await s.api('POST', '/folder', { path: '/definitely/not/here' })).status, 404);
  assert.equal((await s.api('POST', '/folder', {})).status, 400);
  const r = await s.api('POST', '/folder', { path: s.claudeDir });
  assert.equal(r.status, 200);
  assert.equal(r.data.path, s.claudeDir);
});
