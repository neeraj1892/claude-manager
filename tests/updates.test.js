'use strict';
// Updates-from-Anthropic: CLI version check (npm), hook-event discovery (docs),
// applying new events, and running `claude update`.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { startServer } = require('./helper');

// Fixture docs page: all 19 built-in events (each appearing 3+ times, as on the
// real page) PLUS a brand-new "WorkspaceChange" event the app doesn't know yet.
const BUILTIN = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
  'SessionStart', 'SessionEnd', 'Setup', 'UserPromptSubmit',
  'Stop', 'StopFailure', 'Notification',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'ConfigChange', 'CwdChanged', 'FileChanged',
];
const DOCS_PAGE = [...BUILTIN, 'WorkspaceChange']
  .map(e => `${e} hook: the ${e} event fires appropriately. Configure ${e} in settings.`)
  .join('\n') + '\nAlso mentioned twice only: RareStart RareStart\nQuickStart QuickStart QuickStart QuickStart';

let s, fixture;
const FIX_PORT = 4695;

before(async () => {
  fixture = http.createServer((req, res) => {
    if (req.url === '/npm-latest') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ version: '10.5.0' })); }
    if (req.url === '/docs-hooks') { res.setHeader('Content-Type', 'text/plain'); return res.end(DOCS_PAGE); }
    res.statusCode = 404; res.end('nope');
  });
  await new Promise(r => fixture.listen(FIX_PORT, r));
  s = await startServer(4690, {
    env: {
      UPDATES_NPM_URL: `http://127.0.0.1:${FIX_PORT}/npm-latest`,
      UPDATES_DOCS_URL: `http://127.0.0.1:${FIX_PORT}/docs-hooks`,
    },
  });
});
after(() => { s.stop(); fixture.close(); });

test('hook-events endpoint lists all 19 official events', async () => {
  const { status, data } = await s.api('GET', '/hook-events');
  assert.equal(status, 200);
  for (const e of BUILTIN) assert.ok(data.builtin.includes(e), 'missing builtin event: ' + e);
  assert.deepEqual(data.dynamic, []);
  assert.equal(data.all.length, 19);
});

test('updates/check: CLI version compared against npm latest', async () => {
  const { status, data } = await s.api('GET', '/updates/check');
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.cli.current, '9.9.9', 'parsed from claude --version (shim)');
  assert.equal(data.cli.latest, '10.5.0', 'from npm fixture');
  assert.equal(data.cli.hasUpdate, true);
  assert.ok(data.appVersion);
  assert.ok(data.checkedAt);
});

test('updates/check: discovers NEW hook events from the docs, ignores noise', async () => {
  const { data } = await s.api('GET', '/updates/check');
  assert.ok(data.hookEvents, JSON.stringify(data));
  assert.deepEqual(data.hookEvents.newEvents, ['WorkspaceChange'], 'exactly the new event, no false positives: ' + JSON.stringify(data.hookEvents));
  assert.equal(data.hookEvents.knownCount, 19);
  // RareStart appears only twice (below threshold), QuickStart is blocklisted
  assert.ok(!data.hookEvents.newEvents.includes('RareStart'));
  assert.ok(!data.hookEvents.newEvents.includes('QuickStart'));
});

test('applying discovered events adds them to the catalog (and dedupes builtins)', async () => {
  const r = await s.api('POST', '/updates/hook-events/apply', { events: ['WorkspaceChange', 'PreToolUse'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.dynamic, ['WorkspaceChange'], 'builtin filtered out');
  const { data } = await s.api('GET', '/hook-events');
  assert.ok(data.all.includes('WorkspaceChange'));
  assert.equal(data.all.length, 20);
  // Re-check: no longer reported as new
  const check = await s.api('GET', '/updates/check');
  assert.deepEqual(check.data.hookEvents.newEvents, []);
});

test('apply validation: bad payloads -> 400', async () => {
  assert.equal((await s.api('POST', '/updates/hook-events/apply', {})).status, 400);
  assert.equal((await s.api('POST', '/updates/hook-events/apply', { events: [] })).status, 400);
  assert.equal((await s.api('POST', '/updates/hook-events/apply', { events: ['bad name!'] })).status, 400);
});

test('hooks/wire accepts docs-discovered (dynamic) events too', async () => {
  // WorkspaceChange was applied in the previous test — wiring to it must work
  await s.api('POST', '/hooks/files', { name: 'ws-watch.mjs', content: '#!/usr/bin/env node\n// watch' });
  const { status, data } = await s.api('POST', '/hooks/wire', { event: 'WorkspaceChange', filename: 'ws-watch.mjs' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.event, 'WorkspaceChange');
});

test('updates/cli runs `claude update` through the CLI', async () => {
  const { status, data } = await s.api('POST', '/updates/cli', {});
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(s.readShimLog().includes('claude update'), 'claude update executed');
});
