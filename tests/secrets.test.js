'use strict';
// Guard rails: the OpenRouter API key must NEVER live in the repo directory.
// It is stored in ~/.claude-manager.secrets.json (outside the repo), keys
// found in the repo config are migrated out automatically, and the API never
// echoes the key back.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const { startServer } = require('./helper');

let s, appConfig, secretsFile;

before(async () => {
  s = await startServer(4710);
  appConfig = join(s.root, 'app', 'claude-manager.config.json');
  secretsFile = join(s.home, '.claude-manager.secrets.json');
});
after(() => s.stop());

test('saving a key writes it OUTSIDE the repo, never into the config file', async () => {
  const { status } = await s.api('PUT', '/ai-config', { openRouterKey: 'sk-or-super-secret-123', openRouterModel: 'openai/gpt-4o-mini' });
  assert.equal(status, 200);
  const { data } = await s.api('GET', '/ai-config');
  assert.equal(data.hasOpenRouterKey, true, 'key usable');
  assert.equal(data.openRouterModel, 'openai/gpt-4o-mini', 'non-secret prefs still in config');

  // Repo config: no key, not even the field
  const cfg = readFileSync(appConfig, 'utf8');
  assert.ok(!cfg.includes('sk-or-super-secret-123'), 'key value not in repo config');
  assert.ok(!cfg.includes('openRouterKey'), 'key field not in repo config');
  // Secrets file in HOME holds it
  assert.ok(existsSync(secretsFile), 'secrets file created in HOME');
  assert.ok(readFileSync(secretsFile, 'utf8').includes('sk-or-super-secret-123'));
});

test('the API never echoes the key back to the browser', async () => {
  const { data } = await s.api('GET', '/ai-config');
  assert.ok(!JSON.stringify(data).includes('sk-or-super-secret-123'), 'ai-config response is key-free');
});

test('model-only updates preserve the stored key', async () => {
  await s.api('PUT', '/ai-config', { openRouterModel: 'anthropic/claude-opus-4-5' });
  const { data } = await s.api('GET', '/ai-config');
  assert.equal(data.hasOpenRouterKey, true, 'key survived a model-only save');
  assert.equal(data.openRouterModel, 'anthropic/claude-opus-4-5');
});

test('MIGRATION: a key found inside the repo config is moved out automatically', async () => {
  // Simulate the pre-guard-rail state: key sitting in the repo config file
  const cfg = JSON.parse(readFileSync(appConfig, 'utf8'));
  cfg.openRouterKey = 'sk-or-legacy-leaked-456';
  writeFileSync(appConfig, JSON.stringify(cfg, null, 2));

  // Any config read (e.g. ai-config) triggers the migration
  const { data } = await s.api('GET', '/ai-config');
  assert.equal(data.hasOpenRouterKey, true);
  const after_ = readFileSync(appConfig, 'utf8');
  assert.ok(!after_.includes('sk-or-legacy-leaked-456'), 'leaked key scrubbed from repo config');
  assert.ok(!after_.includes('openRouterKey'), 'field removed entirely');
});

test('clearing the key removes it from the secrets file', async () => {
  await s.api('PUT', '/ai-config', { openRouterKey: '' });
  const { data } = await s.api('GET', '/ai-config');
  assert.equal(data.hasOpenRouterKey, false);
  assert.ok(!readFileSync(secretsFile, 'utf8').includes('openRouterKey'), 'secret deleted');
});

test('.gitignore covers the config file', () => {
  const gi = readFileSync(join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(gi.includes('claude-manager.config.json'), 'config gitignored');
});

test('the repo git index contains no config or secrets file', () => {
  const { execSync } = require('child_process');
  const tracked = execSync('git ls-files', { cwd: join(__dirname, '..') }).toString();
  assert.ok(!tracked.split('\n').includes('claude-manager.config.json'), 'config not tracked by git');
  assert.ok(!/(^|\/)[^\n]*secrets\.json$/m.test(tracked), 'no secrets json tracked');
});
