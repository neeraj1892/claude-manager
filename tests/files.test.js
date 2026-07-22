'use strict';
// Deep file visibility: recursive hooks/agents discovery, hook files inside
// skills/plugins, nested agents, and the generic safe file API.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { mkdirSync, writeFileSync, readFileSync } = require('fs');
const { join } = require('path');
const { startServer } = require('./helper');

let s;
before(async () => {
  s = await startServer(4680);
  const c = s.claudeDir;
  // hooks/ with a nested subfolder AND a directory trap named like a hook file
  mkdirSync(join(c, 'hooks', 'guards'), { recursive: true });
  mkdirSync(join(c, 'hooks', 'trap.js'), { recursive: true }); // dir named like a file
  writeFileSync(join(c, 'hooks', 'top.mjs'), '// top hook');
  writeFileSync(join(c, 'hooks', 'guards', 'inner.py'), '# nested hook');
  // a skill with its own scripts/hooks/references
  mkdirSync(join(c, 'skills', 'deep-skill', 'scripts'), { recursive: true });
  mkdirSync(join(c, 'skills', 'deep-skill', 'hooks'), { recursive: true });
  mkdirSync(join(c, 'skills', 'deep-skill', 'references'), { recursive: true });
  writeFileSync(join(c, 'skills', 'deep-skill', 'SKILL.md'), '---\nname: deep-skill\ndescription: deep\n---\nBody');
  writeFileSync(join(c, 'skills', 'deep-skill', 'scripts', 'run.py'), 'print("hi")');
  writeFileSync(join(c, 'skills', 'deep-skill', 'hooks', 'pre.mjs'), '// skill-shipped hook');
  writeFileSync(join(c, 'skills', 'deep-skill', 'references', 'guide.md'), '# Guide');
  // agents: flat + nested + shipped inside a plugin
  mkdirSync(join(c, 'agents', 'team'), { recursive: true });
  writeFileSync(join(c, 'agents', 'flat.md'), '---\nname: flat\ndescription: flat agent\n---\nBody');
  writeFileSync(join(c, 'agents', 'team', 'nested.md'), '---\nname: nested\ndescription: nested agent\n---\nBody');
  mkdirSync(join(c, 'plugins', 'some-plugin', 'agents'), { recursive: true });
  writeFileSync(join(c, 'plugins', 'some-plugin', 'agents', 'plugin-agent.md'), '---\nname: plugin-agent\ndescription: from plugin\n---\nBody');
  // Marketplace CATALOG checkout — browsable, NOT installed. Must never be listed.
  mkdirSync(join(c, 'plugins', 'marketplaces', 'some-mkt', 'agents'), { recursive: true });
  writeFileSync(join(c, 'plugins', 'marketplaces', 'some-mkt', 'agents', 'catalog-agent.md'), '---\nname: catalog-agent\ndescription: only in catalog\n---\nBody');
  writeFileSync(join(c, 'plugins', 'marketplaces', 'some-mkt', 'agents', 'catalog-hook.py'), '# catalog hook');
});
after(() => s.stop());

// ── Hooks: recursive + elsewhere ──

test('hooks: nested hook files in hooks/ subfolders are listed', async () => {
  const { status, data } = await s.api('GET', '/hooks');
  assert.equal(status, 200);
  const names = data.files.map(f => f.name);
  assert.ok(names.includes('top.mjs'), 'flat hook listed');
  assert.ok(names.includes('guards/inner.py'), 'nested hook listed (was invisible before)');
});

test('hooks: a directory named like a hook file does not break the endpoint', async () => {
  const { status } = await s.api('GET', '/hooks');
  assert.equal(status, 200, 'endpoint must not 500 on hooks/trap.js directory');
});

test('hooks: hook/script files inside skills are surfaced in "elsewhere"', async () => {
  const { data } = await s.api('GET', '/hooks');
  const paths = (data.elsewhere || []).map(f => f.path);
  assert.ok(paths.includes('skills/deep-skill/hooks/pre.mjs'), 'skill-shipped hook found: ' + paths.join(', '));
  assert.ok(paths.includes('skills/deep-skill/scripts/run.py'), 'skill script found');
});

test('hooks: nested hook file can be updated and deleted via files routes', async () => {
  const p = await s.api('PUT', '/hooks/files/' + encodeURIComponent('guards/inner.py'), { content: '# updated' });
  assert.equal(p.status, 200);
  assert.equal(readFileSync(join(s.claudeDir, 'hooks', 'guards', 'inner.py'), 'utf8'), '# updated');
  assert.equal((await s.api('DELETE', '/hooks/files/' + encodeURIComponent('guards/inner.py'))).status, 200);
});

// ── Agents: recursive + external ──

test('agents: nested agents in subfolders are listed', async () => {
  const { data } = await s.api('GET', '/agents');
  const names = data.map(a => a.name);
  assert.ok(names.includes('flat'));
  assert.ok(names.includes('team/nested'), 'nested agent listed (was invisible before): ' + names.join(', '));
});

test('agents: agents shipped inside plugins are listed as external', async () => {
  const { data } = await s.api('GET', '/agents');
  const pa = data.find(a => a.name === 'plugin-agent');
  assert.ok(pa, 'plugin agent listed');
  assert.equal(pa.external, true);
  assert.equal(pa.path, 'plugins/some-plugin/agents/plugin-agent.md');
  assert.ok(pa.locationLabel);
});

test('REGRESSION: marketplace catalog agents/hooks are NOT shown as installed', async () => {
  const agents = await s.api('GET', '/agents');
  assert.ok(!agents.data.some(a => a.name === 'catalog-agent'),
    'agents from plugins/marketplaces (catalog, not installed) must not be listed');
  const hooks = await s.api('GET', '/hooks');
  assert.ok(!(hooks.data.elsewhere || []).some(f => f.path.includes('marketplaces')),
    'hook files from marketplace catalogs must not be listed');
});

test('agents: nested agent readable/writable via /api/agents/:name', async () => {
  const g = await s.api('GET', '/agents/' + encodeURIComponent('team/nested'));
  assert.equal(g.status, 200);
  assert.match(g.data.content, /nested agent/);
  const p = await s.api('PUT', '/agents/' + encodeURIComponent('team/nested'), { content: 'updated nested' });
  assert.equal(p.status, 200);
  assert.equal(readFileSync(join(s.claudeDir, 'agents', 'team', 'nested.md'), 'utf8'), 'updated nested');
});

// ── Generic file API ──

test('files/tree: lists every nested file of a skill', async () => {
  const { status, data } = await s.api('GET', '/files/tree?dir=' + encodeURIComponent('skills/deep-skill'));
  assert.equal(status, 200);
  const paths = data.map(e => e.path);
  for (const expected of ['skills/deep-skill/SKILL.md', 'skills/deep-skill/scripts/run.py', 'skills/deep-skill/hooks/pre.mjs', 'skills/deep-skill/references/guide.md']) {
    assert.ok(paths.includes(expected), 'missing ' + expected + ' in ' + paths.join(', '));
  }
});

test('files: read + write roundtrip on a nested skill file', async () => {
  const rel = 'skills/deep-skill/references/guide.md';
  const g = await s.api('GET', '/files?path=' + encodeURIComponent(rel));
  assert.equal(g.status, 200);
  assert.equal(g.data.content, '# Guide');
  const p = await s.api('PUT', '/files', { path: rel, content: '# Guide v2' });
  assert.equal(p.status, 200);
  assert.equal(readFileSync(join(s.claudeDir, rel), 'utf8'), '# Guide v2');
});

test('hooks: unparseable settings.json is surfaced instead of silently hiding config', async () => {
  writeFileSync(join(s.claudeDir, 'settings.json'), '{ hooks: broken json,,, ');
  const { status, data } = await s.api('GET', '/hooks');
  assert.equal(status, 200);
  assert.ok(data.settingsError, 'settingsError must be reported');
  assert.match(data.settingsError, /settings\.json/);
  writeFileSync(join(s.claudeDir, 'settings.json'), '{}'); // restore
  const after_ = await s.api('GET', '/hooks');
  assert.equal(after_.data.settingsError, null);
});

test('files: PUT creates a brand-new nested file, directories included', async () => {
  const rel = 'skills/deep-skill/references/new/notes.md';
  const p = await s.api('PUT', '/files', { path: rel, content: 'fresh' });
  assert.equal(p.status, 200);
  assert.equal(readFileSync(join(s.claudeDir, rel), 'utf8'), 'fresh');
});

test('files: GET on a directory -> 404; tree on a file -> 404', async () => {
  assert.equal((await s.api('GET', '/files?path=' + encodeURIComponent('skills/deep-skill'))).status, 404);
  assert.equal((await s.api('GET', '/files/tree?dir=' + encodeURIComponent('skills/deep-skill/SKILL.md'))).status, 404);
});

test('agents: inline "tools: Read, Bash" frontmatter is normalized to a list', async () => {
  writeFileSync(join(s.claudeDir, 'agents', 'tooled.md'),
    '---\nname: tooled\ndescription: has inline tools\ntools: Read, Bash, WebFetch\n---\nBody');
  const { data } = await s.api('GET', '/agents');
  const a = data.find(x => x.name === 'tooled');
  assert.deepEqual(a.tools, ['Read', 'Bash', 'WebFetch']);
});

test('files: validation and safety', async () => {
  assert.equal((await s.api('GET', '/files')).status, 400, 'path required');
  assert.equal((await s.api('GET', '/files?path=nope.txt')).status, 404);
  assert.equal((await s.api('GET', '/files?path=' + encodeURIComponent('../outside.txt'))).status, 400, 'traversal blocked');
  assert.equal((await s.api('PUT', '/files', { path: '../evil.txt', content: 'x' })).status, 400, 'traversal blocked on write');
  assert.equal((await s.api('GET', '/files/tree?dir=' + encodeURIComponent('../'))).status, 400, 'tree traversal blocked');
  assert.equal((await s.api('GET', '/files/tree?dir=missing-dir')).status, 404);
});
