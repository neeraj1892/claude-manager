'use strict';
// Customizable AI prompts: registry listing, overrides actually used by the
// generation endpoints, template-token validation, reset.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer } = require('./helper');

let s;
before(async () => { s = await startServer(4730); });
after(() => s.stop());

test('registry lists every prompt with defaults and metadata', async () => {
  const { status, data } = await s.api('GET', '/prompts');
  assert.equal(status, 200);
  const ids = data.map(p => p.id);
  for (const id of ['skill-generate', 'agent-generate', 'command-generate', 'hook-generate-node',
                    'hook-generate-python', 'hook-generate-bash', 'skill-creator-builtin',
                    'improve', 'explain', 'workflow-plan', 'compose-workflow', 'custom-event', 'suggest-settings']) {
    assert.ok(ids.includes(id), 'missing prompt: ' + id);
  }
  data.forEach(p => {
    assert.ok(p.label && p.usedBy, p.id + ' has label + usedBy');
    assert.ok(p.default.length > 50, p.id + ' has a real default');
    assert.equal(p.isCustomized, false);
    assert.equal(p.current, p.default, 'current equals default before customization');
  });
  const ce = data.find(p => p.id === 'custom-event');
  assert.deepEqual(ce.tokens, ['{{EVENTS}}', '{{LANG_RULES}}', '{{EXT}}'], 'template tokens declared');
});

test('customizing snapshots the default hash; drift is reported; reset clears it', async () => {
  await s.api('PUT', '/prompts/explain', { content: 'my custom explain prompt' });
  let p = (await s.api('GET', '/prompts')).data.find(x => x.id === 'explain');
  assert.equal(p.isCustomized, true);
  assert.equal(p.defaultChanged, false, 'default has not changed since the customization');
  await s.api('DELETE', '/prompts/explain');
  p = (await s.api('GET', '/prompts')).data.find(x => x.id === 'explain');
  assert.equal(p.isCustomized, false);
  assert.equal(p.defaultChanged, false, 'reset clears the snapshot');
});

test('an override is actually used by generation', async () => {
  const custom = 'MY_CUSTOM_SKILL_PROMPT — produce a SKILL.md.\n\nRequest: ';
  const put = await s.api('PUT', '/prompts/skill-generate', { content: custom });
  assert.equal(put.status, 200);

  const gen = await s.api('POST', '/ai/generate-skill', { prompt: 'test skill', provider: 'claude-cli', type: 'skill' });
  assert.equal(gen.status, 200);
  const sent = s.readShimPrompt();
  assert.ok(sent.startsWith('MY_CUSTOM_SKILL_PROMPT'), 'customized prompt reaches the AI: ' + sent.slice(0, 60));
  assert.ok(sent.endsWith('Request: test skill'), 'user request still appended');

  const list = await s.api('GET', '/prompts');
  const p = list.data.find(x => x.id === 'skill-generate');
  assert.equal(p.isCustomized, true);
  assert.equal(p.current, custom);
  assert.notEqual(p.default, custom, 'default preserved for reset');
});

test('template prompts: tokens are validated on save and substituted at use', async () => {
  // Missing tokens → rejected with a message naming them
  const bad = await s.api('PUT', '/prompts/custom-event', { content: 'no tokens here' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /\{\{EVENTS\}\}/);

  // Valid template → accepted and substituted in the real call
  const ok = await s.api('PUT', '/prompts/custom-event', {
    content: 'CUSTOM custom-event designer TEMPLATE. Events: {{EVENTS}}. Lang: {{LANG_RULES}}. Ext: {{EXT}}. Output ONLY raw JSON.\nRequest: ',
  });
  assert.equal(ok.status, 200);
  const r = await s.api('POST', '/ai/create-custom-event', { description: 'git push', provider: 'claude-cli', lang: '.py' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sent = s.readShimPrompt();
  assert.ok(sent.startsWith('CUSTOM custom-event designer TEMPLATE'), 'override used');
  assert.ok(sent.includes('PreToolUse') && sent.includes('FileChanged'), '{{EVENTS}} substituted');
  assert.ok(sent.includes('Python 3 (.py)'), '{{LANG_RULES}} substituted');
  assert.ok(!sent.includes('{{EXT}}'), 'no raw tokens leak to the AI');
});

test('reset restores the built-in default', async () => {
  await s.api('DELETE', '/prompts/skill-generate');
  await s.api('DELETE', '/prompts/custom-event');
  const list = await s.api('GET', '/prompts');
  const p = list.data.find(x => x.id === 'skill-generate');
  assert.equal(p.isCustomized, false);
  assert.equal(p.current, p.default);
  // generation uses the default again
  await s.api('POST', '/ai/generate-skill', { prompt: 'x', provider: 'claude-cli', type: 'skill' });
  assert.ok(s.readShimPrompt().includes('expert Claude Code skill author'), 'default prompt back in use');
});

test('validation: unknown id -> 404, empty content -> 400', async () => {
  assert.equal((await s.api('PUT', '/prompts/nope', { content: 'x' })).status, 404);
  assert.equal((await s.api('DELETE', '/prompts/nope')).status, 404);
  assert.equal((await s.api('PUT', '/prompts/explain', { content: '   ' })).status, 400);
});

test('overrides for improve + explain flow through their endpoints', async () => {
  await s.api('PUT', '/prompts/improve', {
    content: 'MY_IMPROVE {{TYPE}} {{TYPE_UPPER}}\n{{FEEDBACK}}{{VALIDATION}}\nORIGINAL:\n',
  });
  await s.api('POST', '/ai/improve-skill', { content: 'body', provider: 'claude-cli', type: 'skill' });
  let sent = s.readShimPrompt();
  assert.ok(sent.startsWith('MY_IMPROVE skill SKILL'), 'improve template substituted: ' + sent.slice(0, 40));

  await s.api('PUT', '/prompts/explain', { content: 'MY_EXPLAIN_PROMPT\n\n' });
  await s.api('POST', '/ai/explain', { content: 'thing', type: 'skill', provider: 'claude-cli' });
  sent = s.readShimPrompt();
  assert.ok(sent.startsWith('MY_EXPLAIN_PROMPT'), 'explain override used');
});
