'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { startServer } = require('./helper');

let s, orServer;
const OR_PORT = 4655;

before(async () => {
  // Fixture OpenRouter endpoint: returns prose for PROSE_TEST prompts,
  // valid SKILL.md frontmatter otherwise.
  orServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const userMsg = (JSON.parse(body).messages || []).map(m => m.content).join('\n');
      res.setHeader('Content-Type', 'application/json');
      const content = userMsg.includes('PROSE_TEST')
        ? 'Sure! I would be happy to describe a skill for you. It would...'
        : '---\nname: or-generated\ndescription: generated via openrouter fixture\n---\n\n# OR Skill';
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise(r => orServer.listen(OR_PORT, r));
  s = await startServer(4650, {
    seedSkillCreator: true,
    env: { OPENROUTER_ENDPOINT: `http://127.0.0.1:${OR_PORT}/api/v1/chat/completions` },
  });
});
after(() => { s.stop(); orServer.close(); });

test('ai-config reports claude CLI available (shim on PATH)', async () => {
  const { data } = await s.api('GET', '/ai-config');
  assert.equal(data.claudeCli, true);
});

test('generate-skill requires prompt', async () => {
  const { status } = await s.api('POST', '/ai/generate-skill', {});
  assert.equal(status, 400);
});

test('generate-skill with openrouter but no key -> 400', async () => {
  const { status, data } = await s.api('POST', '/ai/generate-skill', { prompt: 'x', provider: 'openrouter' });
  assert.equal(status, 400);
  assert.match(data.error, /OpenRouter/);
});

test('generate-skill via claude CLI returns SKILL.md content', async () => {
  const { status, data } = await s.api('POST', '/ai/generate-skill', { prompt: 'make a skill that lints code', provider: 'claude-cli', type: 'skill' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.content.startsWith('---'), 'must start with YAML frontmatter');
  assert.match(data.content, /generated-skill/);
});

test('REGRESSION: creatorContent ending in "Request: " is appended directly (endsWithRequest bug)', async () => {
  // The installed skill-creator SKILL.md seeded by the helper ends with "Request: ".
  const creators = await s.api('GET', '/skills/creators');
  const installed = creators.data[0];
  assert.equal(installed.name, 'skill-creator (Installed)');

  const { status } = await s.api('POST', '/ai/generate-skill', {
    prompt: 'UNIQUE_TEST_PROMPT_123', provider: 'claude-cli', type: 'skill',
    creatorContent: installed.content,
  });
  assert.equal(status, 200);

  const prompt = s.readShimPrompt();
  assert.ok(prompt.includes('REAL INSTALLED OFFICIAL CREATOR'), 'installed creator methodology must be in the prompt');
  assert.ok(prompt.trimEnd().endsWith('Request: UNIQUE_TEST_PROMPT_123'),
    'prompt must end with "Request: <user prompt>" (direct append), got tail: …' + prompt.slice(-80));
  // The generic wrapper adds a second "Request:" block — it must NOT be used here
  assert.ok(!prompt.includes('CRITICAL: Your response must be ONLY'),
    'wrapper scaffolding must not be added when creator content already ends with "Request:"');
  assert.equal((prompt.match(/Request:/g) || []).length, 1, 'exactly one Request: marker');
});

test('creatorContent WITHOUT trailing "Request:" gets the wrapper', async () => {
  const { status } = await s.api('POST', '/ai/generate-skill', {
    prompt: 'wrapped prompt', provider: 'claude-cli', type: 'skill',
    creatorContent: '---\nname: custom\n---\nSome methodology with skill-creation guidance.',
  });
  assert.equal(status, 200);
  const prompt = s.readShimPrompt();
  assert.ok(prompt.includes('CRITICAL: Your response must be ONLY'), 'wrapper must be applied');
  assert.ok(prompt.trimEnd().endsWith('Request: wrapped prompt'));
});

test('generate agent returns frontmatter content', async () => {
  const { status, data } = await s.api('POST', '/ai/generate-skill', { prompt: 'security agent', provider: 'claude-cli', type: 'agent' });
  assert.equal(status, 200);
  assert.ok(data.content.startsWith('---'));
});

test('generate hook returns shebang script', async () => {
  const { status, data } = await s.api('POST', '/ai/generate-skill', { prompt: 'block dangerous commands', provider: 'claude-cli', type: 'hook', hookLang: '.mjs' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.content.startsWith('#!/usr/bin/env node'), 'hook must start with shebang: ' + data.content.slice(0, 40));
});

test('generate command returns markdown content (Generate with AI in Commands)', async () => {
  const { status, data } = await s.api('POST', '/ai/generate-skill', { prompt: 'a changelog command', provider: 'claude-cli', type: 'command' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.type, 'command');
  assert.ok(data.content.startsWith('---') || data.content.startsWith('#'), 'command must be markdown with frontmatter or heading');
  const prompt = s.readShimPrompt();
  assert.ok(prompt.includes('slash-command author'), 'command system prompt must be used');
});

test('improve-skill requires content', async () => {
  const { status } = await s.api('POST', '/ai/improve-skill', {});
  assert.equal(status, 400);
});

test('improve-skill returns improved content via CLI', async () => {
  const { status, data } = await s.api('POST', '/ai/improve-skill', { content: '---\nname: x\n---\nbody', provider: 'claude-cli', type: 'skill' });
  assert.equal(status, 200);
  assert.ok(data.content.length > 0);
});

test('generate-workflow-plan returns parsed JSON plan', async () => {
  const { status, data } = await s.api('POST', '/ai/generate-workflow-plan', { goal: 'automate PR reviews', provider: 'claude-cli' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.name, 'test-workflow');
  assert.ok(Array.isArray(data.components) && data.components.length === 1);
});

test('generate-workflow-plan requires goal', async () => {
  const { status } = await s.api('POST', '/ai/generate-workflow-plan', {});
  assert.equal(status, 400);
});

test('compose-workflow: analyzes feasibility against installed inventory', async () => {
  const { mkdirSync, writeFileSync } = require('fs');
  const { join } = require('path');
  mkdirSync(join(s.claudeDir, 'skills', 'compose-skill'), { recursive: true });
  writeFileSync(join(s.claudeDir, 'skills', 'compose-skill', 'SKILL.md'), '---\nname: compose-skill\ndescription: composes\n---\nBody');

  const { status, data } = await s.api('POST', '/ai/compose-workflow', { goal: 'do the thing automatically', provider: 'claude-cli' });
  assert.equal(status, 200, JSON.stringify(data));
  // Installed component kept and verified
  const kept = data.components.find(c => c.name === 'compose-skill');
  assert.ok(kept && kept.exists === true, 'installed component verified against inventory');
  // Hallucinated component moved to missing — the UI never claims something is installed when it is not
  assert.ok(!data.components.some(c => c.name === 'ghost-skill'), 'non-installed component removed from components');
  assert.ok(data.missing.some(m => m.name === 'ghost-skill'), 'non-installed component moved to missing');
  assert.ok(data.missing.some(m => m.name === 'guard-hook'), 'genuinely missing piece listed');
  assert.equal(data.feasible, 'partial', 'feasibility downgraded because pieces are missing');
  assert.ok(Array.isArray(data.setupGuide) && data.setupGuide.length);
  assert.ok(data.inventoryCounts.skills >= 1);
});

test('compose-workflow: validation (goal required, openrouter needs key)', async () => {
  assert.equal((await s.api('POST', '/ai/compose-workflow', {})).status, 400);
});

test('ai-config PUT stores openrouter key and model', async () => {
  const { status } = await s.api('PUT', '/ai-config', { openRouterKey: 'sk-test', openRouterModel: 'anthropic/claude-sonnet-4-5' });
  assert.equal(status, 200);
  const { data } = await s.api('GET', '/ai-config');
  assert.equal(data.hasOpenRouterKey, true);
});

// ── OpenRouter provider paths (fixture endpoint) ──

test('generate-skill via openrouter returns fixture content', async () => {
  const { status, data } = await s.api('POST', '/ai/generate-skill', { prompt: 'make a skill', provider: 'openrouter', type: 'skill' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.content.startsWith('---'));
  assert.match(data.content, /or-generated/);
});

test('generate-skill via openrouter: prose response is rejected with a clear error', async () => {
  const { status, data } = await s.api('POST', '/ai/generate-skill', { prompt: 'PROSE_TEST please', provider: 'openrouter', type: 'skill' });
  assert.equal(status, 500);
  assert.match(data.error, /description instead of file content/);
});

test('improve-skill via openrouter works', async () => {
  const { status, data } = await s.api('POST', '/ai/improve-skill', { content: '---\nname: x\n---\nbody', provider: 'openrouter', type: 'skill' });
  assert.equal(status, 200);
  assert.ok(data.content.length > 0);
});

// ── Hook language selection ──

test('hookLang .py selects the Python system prompt', async () => {
  const { status } = await s.api('POST', '/ai/generate-skill', { prompt: 'log writes', provider: 'claude-cli', type: 'hook', hookLang: '.py' });
  assert.equal(status, 200);
  assert.ok(s.readShimPrompt().includes('Python 3 hooks'), 'python prompt used');
});

test('hookLang .sh selects the Bash system prompt', async () => {
  const { status } = await s.api('POST', '/ai/generate-skill', { prompt: 'guard commands', provider: 'claude-cli', type: 'hook', hookLang: '.sh' });
  assert.equal(status, 200);
  assert.ok(s.readShimPrompt().includes('Bash shell hooks'), 'bash prompt used');
});

// ── Output hygiene ──

test('code-fence-wrapped AI output is stripped to raw content', async () => {
  const { status, data } = await s.api('POST', '/ai/generate-skill', { prompt: 'FENCED_TEST make it', provider: 'claude-cli', type: 'skill' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.content.startsWith('---'), 'fence stripped, starts with frontmatter: ' + data.content.slice(0, 30));
  assert.ok(!data.content.includes('```'), 'no fences remain');
});

// ── Improve with feedback, Explain, full workflow generation ──

test('improve-skill forwards user feedback and original content to the model', async () => {
  await s.api('POST', '/ai/improve-skill', { content: 'ORIGINAL_CONTENT_MARKER body', feedback: 'FEEDBACK_MARKER: sharpen triggers', provider: 'claude-cli', type: 'skill' });
  const prompt = s.readShimPrompt();
  assert.ok(prompt.includes('FEEDBACK_MARKER'), 'feedback included');
  assert.ok(prompt.includes('ORIGINAL_CONTENT_MARKER'), 'original content included');
});

test('explain endpoint returns an explanation', async () => {
  const { status, data } = await s.api('POST', '/ai/explain', { content: '---\nname: x\n---\nbody', type: 'skill', provider: 'claude-cli' });
  assert.equal(status, 200);
  assert.ok(data.explanation.length > 0);
  assert.equal((await s.api('POST', '/ai/explain', {})).status, 400);
});

test('generate-workflow (full) returns a component list', async () => {
  const { status, data } = await s.api('POST', '/ai/generate-workflow', { goal: 'automate reviews', provider: 'claude-cli' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(Array.isArray(data.components) && data.components.length >= 1);
  assert.equal((await s.api('POST', '/ai/generate-workflow', {})).status, 400);
});
