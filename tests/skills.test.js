'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const { startServer } = require('./helper');

let s;
before(async () => { s = await startServer(4610, { seedSkillCreator: true }); });
after(() => s.stop());

test('GET /api/skills lists seeded skill', async () => {
  const { status, data } = await s.api('GET', '/skills');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data));
  assert.ok(data.some(sk => sk.name === 'skill-creator'));
});

test('POST /api/skills creates a skill', async () => {
  const { status } = await s.api('POST', '/skills', { name: 'my-skill', content: '---\nname: my-skill\ndescription: test\n---\nBody' });
  assert.equal(status, 201);
  const g = await s.api('GET', '/skills/my-skill');
  assert.equal(g.status, 200);
  assert.match(g.data.content, /my-skill/);
});

test('POST duplicate skill -> 409', async () => {
  const { status } = await s.api('POST', '/skills', { name: 'my-skill' });
  assert.equal(status, 409);
});

test('POST invalid skill name -> 400', async () => {
  for (const name of ['bad name', '../evil', 'a/b', '']) {
    const { status } = await s.api('POST', '/skills', { name });
    assert.equal(status, 400, `name "${name}" should be rejected`);
  }
});

test('PUT updates skill content', async () => {
  const { status } = await s.api('PUT', '/skills/my-skill', { content: 'updated body' });
  assert.equal(status, 200);
  const g = await s.api('GET', '/skills/my-skill');
  assert.equal(g.data.content, 'updated body');
});

test('GET missing skill -> 404', async () => {
  const { status } = await s.api('GET', '/skills/does-not-exist');
  assert.equal(status, 404);
});

test('path traversal in skill name is blocked', async () => {
  const { status } = await s.api('GET', '/skills/..%2F..%2Fsettings');
  assert.ok(status === 400 || status === 404, 'traversal must not succeed, got ' + status);
});

test('DELETE removes skill; second delete -> 404', async () => {
  const d1 = await s.api('DELETE', '/skills/my-skill');
  assert.equal(d1.status, 200);
  const d2 = await s.api('DELETE', '/skills/my-skill');
  assert.equal(d2.status, 404);
});

// ── Regression: /api/skills/creators must not be shadowed by /api/skills/:name ──

test('GET /api/skills/creators returns creator list (route-order regression)', async () => {
  const { status, data } = await s.api('GET', '/skills/creators');
  assert.equal(status, 200, 'creators endpoint must not 404 (was shadowed by /api/skills/:name)');
  assert.ok(Array.isArray(data) && data.length >= 2);
});

test('installed skill-creator skill is FIRST and preferred over built-in', async () => {
  const { data } = await s.api('GET', '/skills/creators');
  assert.equal(data[0].name, 'skill-creator (Installed)');
  assert.equal(data[0].official, true);
  assert.equal(data[0].installed, true);
  assert.match(data[0].content, /REAL INSTALLED OFFICIAL CREATOR/);
  const builtin = data.find(c => c.builtin);
  assert.ok(builtin, 'built-in fallback still present');
});

test('creator-like local skills are detected', async () => {
  mkdirSync(join(s.claudeDir, 'skills', 'my-skill-generator'), { recursive: true });
  writeFileSync(join(s.claudeDir, 'skills', 'my-skill-generator', 'SKILL.md'),
    '---\nname: my-skill-generator\ndescription: generates skills\n---\nBody');
  const { data } = await s.api('GET', '/skills/creators');
  assert.ok(data.some(c => c.name === 'my-skill-generator (Local)'));
});

test('non-creator skills are NOT listed as creators', async () => {
  mkdirSync(join(s.claudeDir, 'skills', 'pdf-tools'), { recursive: true });
  writeFileSync(join(s.claudeDir, 'skills', 'pdf-tools', 'SKILL.md'),
    '---\nname: pdf-tools\ndescription: works with pdf files\n---\nBody');
  const { data } = await s.api('GET', '/skills/creators');
  assert.ok(!data.some(c => c.name.startsWith('pdf-tools')));
});
