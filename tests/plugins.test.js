'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { mkdirSync, writeFileSync, readFileSync } = require('fs');
const { join } = require('path');
const { startServer } = require('./helper');

let s;
before(async () => { s = await startServer(4620); });
after(() => s.stop());

function seed(file, obj) { writeFileSync(file, JSON.stringify(obj, null, 2)); }

test('GET /api/plugins empty -> []', async () => {
  const { status, data } = await s.api('GET', '/plugins');
  assert.equal(status, 200);
  assert.deepEqual(data, []);
});

test('plugins from installed_plugins.json are listed', async () => {
  mkdirSync(join(s.claudeDir, 'plugins'), { recursive: true });
  seed(join(s.claudeDir, 'plugins', 'installed_plugins.json'), {
    plugins: { 'legacy-plugin@1.0.0': [{ version: '1.0.0', scope: 'user', installedAt: '2026-01-01T00:00:00Z' }] },
    enabledPlugins: { 'legacy-plugin@1.0.0': true },
  });
  const { data } = await s.api('GET', '/plugins');
  const p = data.find(x => x.id === 'legacy-plugin@1.0.0');
  assert.ok(p, 'plugin listed');
  assert.equal(p.version, '1.0.0');
  assert.equal(p.enabled, true);
});

test('REGRESSION: plugin recorded only in settings.json enabledPlugins is shown', async () => {
  // This is what `claude plugin install pony@ponytail` writes
  seed(join(s.claudeDir, 'settings.json'), { enabledPlugins: { 'pony@ponytail': true } });
  const { data } = await s.api('GET', '/plugins');
  const p = data.find(x => x.id === 'pony@ponytail');
  assert.ok(p, 'plugin from settings.enabledPlugins must be listed');
  assert.equal(p.enabled, true);
});

test('MCP servers from settings.json mcpServers are listed', async () => {
  seed(join(s.claudeDir, 'settings.json'), {
    enabledPlugins: { 'pony@ponytail': true },
    mcpServers: { 'local-mcp': { type: 'stdio', command: 'npx', args: ['-y', 'x'] } },
  });
  const { data } = await s.api('GET', '/plugins');
  const p = data.find(x => x.id === 'local-mcp');
  assert.ok(p);
  assert.equal(p.isMcpServer, true);
  assert.equal(p.configFile, 'settings.json');
});

test('REGRESSION: MCP servers from global ~/.claude.json (claude mcp add) are listed', async () => {
  seed(join(s.home, '.claude.json'), { mcpServers: { 'global-mcp': { type: 'stdio', command: 'npx' } } });
  const { data } = await s.api('GET', '/plugins');
  const p = data.find(x => x.id === 'global-mcp');
  assert.ok(p, 'MCP server from ~/.claude.json must be listed');
  assert.equal(p.configFile, '~/.claude.json');
});

test('REGRESSION: LOCAL-scope MCP servers (projects[*].mcpServers in ~/.claude.json) are listed', async () => {
  // `claude mcp add` without -s/--scope defaults to local scope and stores here
  seed(join(s.home, '.claude.json'), {
    mcpServers: { 'global-mcp': { type: 'stdio', command: 'npx' } },
    projects: { '/Users/someone/project': { mcpServers: { 'brave-search': { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] } } } },
  });
  const { data } = await s.api('GET', '/plugins');
  const p = data.find(x => x.id === 'brave-search');
  assert.ok(p, 'local-scope MCP server must be listed (was invisible before)');
  assert.equal(p.scope, 'local');
  assert.match(p.configFile, /local: \/Users\/someone\/project/);
});

test('REGRESSION: DELETE removes LOCAL-scope MCP server from projects entry', async () => {
  const { status, data } = await s.api('DELETE', '/plugins/brave-search/mcp');
  assert.equal(status, 200);
  assert.match(data.configFile, /local:/);
  const g = JSON.parse(readFileSync(join(s.home, '.claude.json'), 'utf8'));
  assert.ok(!g.projects['/Users/someone/project'].mcpServers['brave-search']);
  assert.ok(g.mcpServers['global-mcp'], 'other servers untouched');
});

test('REGRESSION: first toggle of plugin enabled via installed_plugins.json disables it', async () => {
  mkdirSync(join(s.claudeDir, 'plugins'), { recursive: true });
  seed(join(s.claudeDir, 'plugins', 'installed_plugins.json'), {
    plugins: { 'toggle-me@1.0.0': [{ version: '1.0.0' }] },
    enabledPlugins: { 'toggle-me@1.0.0': true },
  });
  const t1 = await s.api('PUT', '/plugins/' + encodeURIComponent('toggle-me@1.0.0') + '/toggle', {});
  assert.equal(t1.status, 200);
  assert.equal(t1.data.enabled, false, 'first toggle must flip effective state true -> false');
  const t2 = await s.api('PUT', '/plugins/' + encodeURIComponent('toggle-me@1.0.0') + '/toggle', {});
  assert.equal(t2.data.enabled, true);
});

test('DELETE MCP server from settings.json', async () => {
  const { status } = await s.api('DELETE', '/plugins/local-mcp/mcp');
  assert.equal(status, 200);
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.ok(!settings.mcpServers['local-mcp']);
});

test('REGRESSION: DELETE MCP server from global ~/.claude.json', async () => {
  const { status, data } = await s.api('DELETE', '/plugins/global-mcp/mcp');
  assert.equal(status, 200);
  assert.equal(data.configFile, '~/.claude.json');
  const g = JSON.parse(readFileSync(join(s.home, '.claude.json'), 'utf8'));
  assert.ok(!g.mcpServers['global-mcp']);
});

test('DELETE missing MCP server -> 404', async () => {
  const { status } = await s.api('DELETE', '/plugins/nope/mcp');
  assert.equal(status, 404);
});

test('plugins carry descriptions: from marketplace manifest and MCP catalog', async () => {
  // Marketplace manifest on disk (what `claude plugin marketplace add` stores)
  mkdirSync(join(s.claudeDir, 'plugins', 'marketplaces', 'ponytail', '.claude-plugin'), { recursive: true });
  seed(join(s.claudeDir, 'plugins', 'marketplaces', 'ponytail', '.claude-plugin', 'marketplace.json'), {
    name: 'ponytail',
    plugins: [{ name: 'pony', source: './plugins/pony', description: 'Makes ponytails great again' }],
  });
  seed(join(s.claudeDir, 'settings.json'), {
    enabledPlugins: { 'pony@ponytail': true },
    mcpServers: { filesystem: { type: 'stdio', command: 'npx' }, 'mystery-mcp': { type: 'stdio', command: 'npx', args: ['-y', 'mystery'] } },
  });
  const { data } = await s.api('GET', '/plugins');
  const pony = data.find(p => p.id === 'pony@ponytail');
  assert.match(pony.description, /Makes ponytails great again/, 'description from marketplace manifest');
  const fs_ = data.find(p => p.id === 'filesystem');
  assert.match(fs_.description, /Read, write, and navigate/, 'known MCP server described from catalog');
  const myst = data.find(p => p.id === 'mystery-mcp');
  assert.match(myst.description, /MCP server/, 'unknown MCP server gets a generated description');
});

test('plugin uninstall: runs claude plugin uninstall and cleans local records', async () => {
  const { status, data } = await s.api('POST', '/plugins/' + encodeURIComponent('pony@ponytail') + '/uninstall', {});
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(s.readShimLog().includes('plugin uninstall pony@ponytail'), 'CLI uninstall executed');
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.ok(!('pony@ponytail' in (settings.enabledPlugins || {})), 'removed from enabledPlugins');
  const list = await s.api('GET', '/plugins');
  assert.ok(!list.data.some(p => p.id === 'pony@ponytail'), 'no longer listed');
});

test('plugin reinstall: runs claude plugin install', async () => {
  const { status } = await s.api('POST', '/plugins/' + encodeURIComponent('pony@ponytail') + '/reinstall', {});
  assert.equal(status, 200);
  assert.ok(s.readShimLog().includes('plugin install pony@ponytail'), 'CLI install executed');
});

test('overview counts plugins including enabledPlugins-only entries', async () => {
  const { data } = await s.api('GET', '/overview');
  assert.equal(typeof data.plugins, 'number');
  assert.ok(data.plugins >= 1);
});

test('MCP server present in BOTH settings.json and ~/.claude.json appears once (settings wins)', async () => {
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  settings.mcpServers = { ...(settings.mcpServers || {}), 'both-places': { type: 'stdio', command: 'npx' } };
  seed(join(s.claudeDir, 'settings.json'), settings);
  seed(join(s.home, '.claude.json'), { mcpServers: { 'both-places': { type: 'stdio', command: 'other' } } });
  const { data } = await s.api('GET', '/plugins');
  const matches = data.filter(p => p.id === 'both-places');
  assert.equal(matches.length, 1, 'no duplicates');
  assert.equal(matches[0].configFile, 'settings.json');
});

test('plugin disabled via installed_plugins.json enabledPlugins=false shows disabled', async () => {
  mkdirSync(join(s.claudeDir, 'plugins'), { recursive: true });
  seed(join(s.claudeDir, 'plugins', 'installed_plugins.json'), {
    plugins: { 'off-plugin@1.0.0': [{ version: '1.0.0' }] },
    enabledPlugins: { 'off-plugin@1.0.0': false },
  });
  const { data } = await s.api('GET', '/plugins');
  assert.equal(data.find(p => p.id === 'off-plugin@1.0.0').enabled, false);
});

test('uninstall tolerates CLI "plugin not found" errors (still cleans local records)', async () => {
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  settings.enabledPlugins = { ...(settings.enabledPlugins || {}), 'ghost-plugin': true };
  seed(join(s.claudeDir, 'settings.json'), settings);
  const { status, data } = await s.api('POST', '/plugins/ghost-plugin/uninstall', {});
  assert.equal(status, 200, JSON.stringify(data));
  const after_ = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.ok(!('ghost-plugin' in (after_.enabledPlugins || {})));
});

test('REGRESSION: overview plugin/MCP counts match the Plugins tab exactly', async () => {
  const [{ data: overview }, { data: plugins }] = await Promise.all([
    s.api('GET', '/overview'), s.api('GET', '/plugins'),
  ]);
  const claudePlugins = plugins.filter(p => !p.isMcpServer);
  const mcpServers    = plugins.filter(p => p.isMcpServer);
  assert.equal(overview.plugins, claudePlugins.length,
    `overview.plugins (${overview.plugins}) must equal Plugins-tab count (${claudePlugins.length})`);
  assert.equal(overview.enabledPlugins, claudePlugins.filter(p => p.enabled).length);
  assert.equal(overview.mcpServers, mcpServers.length,
    `overview.mcpServers (${overview.mcpServers}) must equal MCP count (${mcpServers.length})`);
  // Sanity: this server has MCP servers merged from settings.json + ~/.claude.json
  assert.ok(overview.mcpServers >= 1, 'MCP servers are counted at all');
});

test('compose-workflow with an empty toolbox -> helpful 400', async () => {
  // This server has plugins/MCP servers but no skills/agents/hooks/commands
  const { status, data } = await s.api('POST', '/ai/compose-workflow', { goal: 'anything', provider: 'claude-cli' });
  assert.equal(status, 400);
  assert.match(data.error, /Nothing is installed/);
});
