'use strict';
// Skill Store / Agent Store / Hook Store source management.
// Browse/install against live GitHub is intentionally NOT tested (network-dependent);
// these tests cover source CRUD, validation, and input sanitization.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer } = require('./helper');

let s;
before(async () => { s = await startServer(4660); });
after(() => s.stop());

for (const store of ['skill-store', 'agent-store', 'hook-store']) {
  test(`${store}: sources include builtins`, async () => {
    const { status, data } = await s.api('GET', `/${store}/sources`);
    assert.equal(status, 200);
    assert.ok(data.length >= 1);
    assert.ok(data.some(x => x.builtin || x.id === 'official'));
  });

  test(`${store}: add source validation`, async () => {
    assert.equal((await s.api('POST', `/${store}/sources`, { name: 'x' })).status, 400, 'repo required');
    assert.equal((await s.api('POST', `/${store}/sources`, { name: 'x', repo: 'not-a-repo-format' })).status, 400, 'owner/repo format enforced');
    assert.equal((await s.api('POST', `/${store}/sources`, { repo: 'a/b' })).status, 400, 'name required');
  });

  test(`${store}: add, toggle, delete custom source`, async () => {
    const r = await s.api('POST', `/${store}/sources`, { name: 'my-src', repo: 'owner/repo' });
    assert.equal(r.status, 200);
    const id = r.data.id;
    const list = await s.api('GET', `/${store}/sources`);
    const src = list.data.find(x => x.id === id);
    assert.ok(src);
    assert.equal(src.enabled, true);
    const t = await s.api('PUT', `/${store}/sources/${id}/toggle`, {});
    assert.equal(t.data.enabled, false);
    assert.equal((await s.api('PUT', `/${store}/sources/does-not-exist/toggle`, {})).status, 404);
    assert.equal((await s.api('DELETE', `/${store}/sources/${id}`)).status, 200);
    const after_ = await s.api('GET', `/${store}/sources`);
    assert.ok(!after_.data.some(x => x.id === id));
  });
}

test('skill-store install: invalid skill name -> 400', async () => {
  assert.equal((await s.api('POST', '/skill-store/install', { skillName: '../evil' })).status, 400);
  assert.equal((await s.api('POST', '/skill-store/install', {})).status, 400);
});

test('agent-store install: invalid agent name -> 400, unknown source -> 400', async () => {
  assert.equal((await s.api('POST', '/agent-store/install', { agentName: 'a b' })).status, 400);
  assert.equal((await s.api('POST', '/agent-store/install', { agentName: 'ok', sourceId: 'ghost' })).status, 400);
});

test('hook-store install: invalid hook name -> 400, unknown source -> 400', async () => {
  assert.equal((await s.api('POST', '/hook-store/install', { hookName: 'a/../b' })).status, 400);
  assert.equal((await s.api('POST', '/hook-store/install', { hookName: 'ok', sourceId: 'ghost' })).status, 400);
});
