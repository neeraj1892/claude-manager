'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { readFileSync } = require('fs');
const { join } = require('path');
const { startServer } = require('./helper');

// Fixture: a Claude Code plugin marketplace (.claude-plugin/marketplace.json shape)
// Entries have `source` but NO npm package / MCP command — previously uninstallable.
const CLAUDE_MARKETPLACE = {
  name: 'ponytail',
  owner: { name: 'Test Owner' },
  plugins: [
    { name: 'pony', source: './plugins/pony', description: 'A test claude plugin' },
    { name: 'tail', source: { source: 'github', repo: 'o/r' }, description: 'Another plugin' },
  ],
};

// Fixture: an MCP-style custom source with an npm package
const MCP_SOURCE = {
  servers: [
    { name: 'weather', package: 'weather-mcp', description: 'MCP weather server', command: 'npx', args: ['-y', 'weather-mcp'] },
  ],
};

// Fixture: bare-array source with an explicit installCmd
const ARRAY_SOURCE = [
  { name: 'bare-entry', description: 'from a bare array source', installCmd: 'claude mcp add bare-entry -- npx -y bare-mcp' },
];

let s, fixtureServer;
const FIXTURE_PORT = 4635;

before(async () => {
  fixtureServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/marketplace.json') return res.end(JSON.stringify(CLAUDE_MARKETPLACE));
    if (req.url === '/mcp-source.json') return res.end(JSON.stringify(MCP_SOURCE));
    if (req.url === '/array-source.json') return res.end(JSON.stringify(ARRAY_SOURCE));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => fixtureServer.listen(FIXTURE_PORT, r));
  s = await startServer(4630);
  // Disable the NPM source so browse never hits the network
  await s.api('PUT', '/marketplace/sources/npm-mcp/toggle', {});
});
after(() => { s.stop(); fixtureServer.close(); });

let claudeSrcId, mcpSrcId;

test('official marketplace lists plugins, none installed initially', async () => {
  const { status, data } = await s.api('GET', '/marketplace');
  assert.equal(status, 200);
  assert.ok(data.length > 5);
  assert.ok(data.every(p => p.installed === false));
});

test('add custom marketplace source (claude plugin marketplace)', async () => {
  const r = await s.api('POST', '/marketplace/sources', { name: 'ponytail', url: `http://127.0.0.1:${FIXTURE_PORT}/marketplace.json` });
  assert.equal(r.status, 200);
  claudeSrcId = r.data.id;
  const r2 = await s.api('POST', '/marketplace/sources', { name: 'mcp-src', url: `http://127.0.0.1:${FIXTURE_PORT}/mcp-source.json` });
  mcpSrcId = r2.data.id;
});

test('add source validation: missing fields / bad URL -> 400', async () => {
  assert.equal((await s.api('POST', '/marketplace/sources', { name: 'x' })).status, 400);
  assert.equal((await s.api('POST', '/marketplace/sources', { name: 'x', url: 'not a url' })).status, 400);
});

test('REGRESSION: claude-plugin marketplace entries get a usable install command', async () => {
  const { status, data } = await s.api('GET', `/marketplace/browse?source=${claudeSrcId}`);
  assert.equal(status, 200);
  const pony = data.plugins.find(p => p.name === 'pony');
  assert.ok(pony, 'pony plugin listed from custom source');
  assert.equal(pony.pluginType, 'claude-plugin');
  assert.ok(pony.installCmd.includes('claude plugin marketplace add'), 'must add the marketplace first: ' + pony.installCmd);
  assert.ok(pony.installCmd.includes('claude plugin install pony@ponytail'), 'must install name@marketplace: ' + pony.installCmd);
});

test('custom MCP source entries still get claude mcp add command', async () => {
  const { data } = await s.api('GET', `/marketplace/browse?source=${mcpSrcId}`);
  const w = data.plugins.find(p => p.name === 'weather');
  assert.ok(w);
  assert.match(w.installCmd, /^claude mcp add /);
  assert.equal(w.mcpCommand, 'npx');
});

test('REGRESSION: install endpoint accepts chained claude plugin commands', async () => {
  const command = 'claude plugin marketplace add o/ponytail && claude plugin install pony@ponytail';
  const { status, data } = await s.api('POST', '/marketplace/x/install', { command });
  assert.equal(status, 200, JSON.stringify(data));
  const log = s.readShimLog();
  assert.ok(log.includes('plugin marketplace add o/ponytail'), 'marketplace add executed');
  assert.ok(log.includes('plugin install pony@ponytail'), 'plugin install executed');
});

test('install endpoint still accepts claude mcp add', async () => {
  const { status } = await s.api('POST', '/marketplace/y/install', { command: 'claude mcp add foo -- npx -y foo-mcp' });
  assert.equal(status, 200);
});

test('REGRESSION: claude mcp add defaults to --scope user when app runs it', async () => {
  await s.api('POST', '/marketplace/y2/install', { command: 'claude mcp add scopetest -- npx -y scopetest-mcp' });
  const log = s.readShimLog();
  assert.ok(log.includes('mcp add --scope user scopetest'), 'user scope must be injected, got: ' + log.split('\n').filter(l => l.includes('scopetest')).join('|'));
});

test('explicit scope flag is respected (not overridden)', async () => {
  await s.api('POST', '/marketplace/y3/install', { command: 'claude mcp add localtest -s local -- npx -y x' });
  const log = s.readShimLog();
  const line = log.split('\n').find(l => l.includes('localtest'));
  assert.ok(line && !line.includes('--scope user'), 'explicit -s local must not be rewritten: ' + line);
});

test('REGRESSION: "already exists" CLI error is treated as already-installed, not failure', async () => {
  // Shim exits 1 with the real CLI error message when the server name is "dupe"
  const { status, data } = await s.api('POST', '/marketplace/y4/install', { command: 'claude mcp add dupe -- npx -y dupe-mcp' });
  assert.equal(status, 200, 'must not surface as install failure: ' + JSON.stringify(data));
  assert.equal(data.alreadyInstalled, true);
  assert.match(data.output, /already exists/i);
});

test('install endpoint rejects non-claude commands', async () => {
  for (const command of ['rm -rf /', 'npm install evil', 'claude mcp add ok && rm -rf /', 'claude plugin uninstall x', '']) {
    const { status } = await s.api('POST', '/marketplace/z/install', { command });
    assert.equal(status, 400, `command "${command}" must be rejected`);
  }
});

test('direct-install writes MCP server to settings.json', async () => {
  const { status } = await s.api('POST', '/marketplace/direct-install', {
    serverId: 'weather', type: 'stdio', command: 'npx', args: ['-y', 'weather-mcp'],
  });
  assert.equal(status, 200);
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.mcpServers.weather.args, ['-y', 'weather-mcp']);
});

test('direct-install validation: missing serverId / missing command+url -> 400', async () => {
  assert.equal((await s.api('POST', '/marketplace/direct-install', { command: 'npx' })).status, 400);
  assert.equal((await s.api('POST', '/marketplace/direct-install', { serverId: 'x' })).status, 400);
});

test('direct-install sse type with url', async () => {
  const { status } = await s.api('POST', '/marketplace/direct-install', { serverId: 'remote', type: 'sse', url: 'https://example.com/sse' });
  assert.equal(status, 200);
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.equal(settings.mcpServers.remote.url, 'https://example.com/sse');
});

test('REGRESSION: installed badge shows for custom-source plugin after direct-install', async () => {
  const { data } = await s.api('GET', `/marketplace/browse?source=${mcpSrcId}`);
  const w = data.plugins.find(p => p.name === 'weather');
  assert.equal(w.installed, true, 'installed detection must match mcpServerId/name, not the prefixed source id');
});

test('REGRESSION: installed badge shows for claude plugin after claude plugin install', async () => {
  // Simulate what `claude plugin install pony@ponytail` records
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  settings.enabledPlugins = { 'pony@ponytail': true };
  await s.api('PUT', '/settings', { settings });
  const { data } = await s.api('GET', `/marketplace/browse?source=${claudeSrcId}`);
  const pony = data.plugins.find(p => p.name === 'pony');
  assert.equal(pony.installed, true);
  // ...and it appears in the Installed Plugins list
  const list = await s.api('GET', '/plugins');
  assert.ok(list.data.some(p => p.id === 'pony@ponytail'));
});

test('installed badge for official plugin installed via claude mcp add into ~/.claude.json', async () => {
  const { writeFileSync } = require('fs');
  writeFileSync(join(s.home, '.claude.json'), JSON.stringify({ mcpServers: { filesystem: { type: 'stdio', command: 'npx' } } }));
  const { data } = await s.api('GET', '/marketplace');
  const fs_ = data.find(p => p.id === 'filesystem');
  assert.equal(fs_.installed, true, 'must detect servers registered in global ~/.claude.json');
});

test('browse search filter works', async () => {
  const { data } = await s.api('GET', `/marketplace/browse?source=${claudeSrcId}&q=pony`);
  assert.ok(data.plugins.some(p => p.name === 'pony'));
  assert.ok(!data.plugins.some(p => p.name === 'tail'));
});

test('bare-array custom sources work; explicit installCmd is preserved', async () => {
  const r = await s.api('POST', '/marketplace/sources', { name: 'array-src', url: `http://127.0.0.1:${FIXTURE_PORT}/array-source.json` });
  const { data } = await s.api('GET', `/marketplace/browse?source=${r.data.id}`);
  const e = data.plugins.find(p => p.name === 'bare-entry');
  assert.ok(e, 'entry from bare array listed');
  assert.equal(e.installCmd, 'claude mcp add bare-entry -- npx -y bare-mcp', 'author-provided installCmd untouched');
  await s.api('DELETE', `/marketplace/sources/${r.data.id}`);
});

test('unreachable custom source degrades to zero entries, browse still 200', async () => {
  const r = await s.api('POST', '/marketplace/sources', { name: 'dead-src', url: 'http://127.0.0.1:59321/nope.json' });
  const { status, data } = await s.api('GET', `/marketplace/browse?source=${r.data.id}`);
  assert.equal(status, 200);
  assert.deepEqual(data.plugins, []);
  await s.api('DELETE', `/marketplace/sources/${r.data.id}`);
});

test('browse returns per-source summary counts', async () => {
  const { data } = await s.api('GET', `/marketplace/browse?source=${mcpSrcId}`);
  assert.ok(Array.isArray(data.sources));
  const src = data.sources.find(x => x.id === mcpSrcId);
  assert.ok(src);
  assert.equal(typeof src.count, 'number');
  assert.ok(src.count >= 1);
});

test('direct-install on an existing serverId overwrites its config', async () => {
  await s.api('POST', '/marketplace/direct-install', { serverId: 'weather', type: 'stdio', command: 'node', args: ['new.js'] });
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.equal(settings.mcpServers.weather.command, 'node');
  assert.deepEqual(settings.mcpServers.weather.args, ['new.js']);
});

test('toggle and delete custom source', async () => {
  const t = await s.api('PUT', `/marketplace/sources/${claudeSrcId}/toggle`, {});
  assert.equal(t.data.enabled, false);
  const d = await s.api('DELETE', `/marketplace/sources/${claudeSrcId}`);
  assert.equal(d.status, 200);
  const srcs = await s.api('GET', '/marketplace/sources');
  assert.ok(!srcs.data.some(x => x.id === claudeSrcId));
});
