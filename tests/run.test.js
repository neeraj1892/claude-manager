'use strict';
// One-shot runner: skills/agents/commands/workflows executed via `claude -p
// --dangerously-skip-permissions --output-format stream-json`, streamed to JSONL.
// Also covers /api/run/info (argument discovery + manual command) and the
// OpenRouter text-only provider (against a local fixture endpoint).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { readFileSync, existsSync, mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const http = require('http');
const { startServer } = require('./helper');

let s, orServer;
const OR_PORT = 4675;

before(async () => {
  // Fixture OpenRouter endpoint
  orServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const parsed = JSON.parse(body);
      res.end(JSON.stringify({ choices: [{ message: { content: `SIMULATED RUN OUTPUT (model=${parsed.model}) for: ` + (parsed.messages?.[1]?.content || '') } }] }));
    });
  });
  await new Promise(r => orServer.listen(OR_PORT, r));
  s = await startServer(4670, { env: { OPENROUTER_ENDPOINT: `http://127.0.0.1:${OR_PORT}/api/v1/chat/completions` } });
  // Seed a skill with argument-hint frontmatter + a command
  mkdirSync(join(s.claudeDir, 'skills', 'my-skill'), { recursive: true });
  writeFileSync(join(s.claudeDir, 'skills', 'my-skill', 'SKILL.md'),
    '---\nname: my-skill\ndescription: Reviews a pull request.\nargument-hint: "[PR number or URL]"\nwhen_to_use: Use when the user says review this PR.\n---\nBody');
  mkdirSync(join(s.claudeDir, 'commands'), { recursive: true });
  writeFileSync(join(s.claudeDir, 'commands', 'changelog.md'), '---\ndescription: Builds a changelog.\nargument-hint: "[base tag]"\n---\n# /changelog');
});
after(() => { s.stop(); orServer.close(); });

// ── run/info: argument discovery + manual command ──

test('run/info returns description, argument hint, and a copyable manual command', async () => {
  const { status, data } = await s.api('GET', '/run/info?kind=skill&name=my-skill');
  assert.equal(status, 200);
  assert.equal(data.exists, true);
  assert.match(data.description, /Reviews a pull request/);
  assert.ok(data.argumentHint.includes('[PR number or URL]'), 'argument hint surfaced: ' + data.argumentHint);
  assert.match(data.whenToUse, /review this PR/);
  assert.ok(data.manualCommand.startsWith('claude -p '), 'manual command provided');
  assert.ok(data.manualCommand.includes('--dangerously-skip-permissions'));
  assert.ok(data.manualCommand.includes('/my-skill'));
});

test('run/info for commands and missing artifacts', async () => {
  const cmd = await s.api('GET', '/run/info?kind=command&name=changelog');
  assert.equal(cmd.data.exists, true);
  assert.ok(cmd.data.argumentHint.includes('[base tag]'));
  const missing = await s.api('GET', '/run/info?kind=skill&name=ghost');
  assert.equal(missing.status, 200);
  assert.equal(missing.data.exists, false);
  assert.equal((await s.api('GET', '/run/info?kind=virus&name=x')).status, 400);
  assert.equal((await s.api('GET', '/run/info?kind=skill&name=..%2Fetc')).status, 400);
});

async function waitForRun(id, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await s.api('GET', '/run/' + id);
    if (data && data.running === false) return data;
    if (Date.now() > deadline) throw new Error('run did not finish: ' + JSON.stringify(data));
    await new Promise(r => setTimeout(r, 200));
  }
}

test('run validation: bad inputs -> 400', async () => {
  assert.equal((await s.api('POST', '/run/start', { name: '../evil', outputFile: '/tmp/x.jsonl' })).status, 400);
  assert.equal((await s.api('POST', '/run/start', { name: 'ok' })).status, 400, 'outputFile required');
  assert.equal((await s.api('POST', '/run/start', { kind: 'virus', name: 'ok', outputFile: '/tmp/x.jsonl' })).status, 400, 'kind whitelist');
  assert.equal((await s.api('POST', '/run/start', { name: 'ok', outputFile: '/tmp/x.jsonl', cwd: '/no/such/dir' })).status, 400, 'cwd must exist');
});

test('skill run: streams stream-json events into the chosen JSONL file', async () => {
  const out = join(s.home, 'runs', 'my-run'); // extension intentionally omitted
  const r = await s.api('POST', '/run/start', {
    kind: 'skill', name: 'my-skill', task: 'do the thing', outputFile: out, cwd: s.home,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.file.endsWith('.jsonl'), '.jsonl appended automatically');
  assert.match(r.data.command, /--dangerously-skip-permissions/);

  const done = await waitForRun(r.data.id);
  assert.equal(done.exitCode, 0);
  assert.ok(done.lines >= 3, 'events counted: ' + done.lines);
  assert.ok(existsSync(done.file), 'JSONL file exists');
  const lines = readFileSync(done.file, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 3);
  lines.forEach(l => JSON.parse(l)); // every line is valid JSON
  assert.equal(JSON.parse(lines[lines.length - 1]).type, 'result');

  // The prompt is the slash-command invocation of the skill
  const prompt = s.readShimPrompt();
  assert.equal(prompt, '/my-skill do the thing');
});

test('agent run: prompt points at the agent definition file', async () => {
  const r = await s.api('POST', '/run/start', {
    kind: 'agent', name: 'reviewer', task: 'review src/', outputFile: join(s.home, 'runs', 'agent.jsonl'), cwd: s.home,
  });
  assert.equal(r.status, 200);
  await waitForRun(r.data.id);
  const prompt = s.readShimPrompt();
  assert.ok(prompt.includes(join('agents', 'reviewer.md')), 'prompt references agent file');
  assert.ok(prompt.includes('review src/'));
});

test('workflow run: free-form goal prompt', async () => {
  const r = await s.api('POST', '/run/start', {
    kind: 'workflow', name: 'Smart Commit', task: 'commit my changes properly', outputFile: join(s.home, 'runs', 'wf.jsonl'), cwd: s.home,
  });
  assert.equal(r.status, 200);
  await waitForRun(r.data.id);
  assert.equal(s.readShimPrompt(), 'commit my changes properly');
});

test('command run: invoked as slash command', async () => {
  const r = await s.api('POST', '/run/start', {
    kind: 'command', name: 'changelog', task: 'v1.2.0', outputFile: join(s.home, 'runs', 'cmd.jsonl'), cwd: s.home,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await waitForRun(r.data.id);
  assert.equal(s.readShimPrompt(), '/changelog v1.2.0');
});

// ── OpenRouter provider (text-only) ──

test('openrouter run: rejected without an API key', async () => {
  const { status, data } = await s.api('POST', '/run/start', {
    kind: 'skill', name: 'my-skill', provider: 'openrouter', outputFile: join(s.home, 'runs', 'or0.jsonl'),
  });
  assert.equal(status, 400);
  assert.match(data.error, /OpenRouter API key/);
});

test('openrouter run: text-only run writes JSONL events with definition context', async () => {
  await s.api('PUT', '/ai-config', { openRouterKey: 'sk-test-or' });
  const r = await s.api('POST', '/run/start', {
    kind: 'skill', name: 'my-skill', task: 'review PR 42', provider: 'openrouter',
    outputFile: join(s.home, 'runs', 'or1.jsonl'),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.provider, 'openrouter');
  assert.match(r.data.note, /text-only/i);

  const done = await waitForRun(r.data.id);
  assert.equal(done.exitCode, 0, JSON.stringify(done));
  const lines = readFileSync(done.file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines[0].type, 'system');
  assert.equal(lines[0].provider, 'openrouter');
  const assistant = lines.find(l => l.type === 'assistant');
  assert.ok(assistant, 'assistant event written');
  assert.match(assistant.message.content[0].text, /SIMULATED RUN OUTPUT/);
  assert.match(assistant.message.content[0].text, /review PR 42/, 'task forwarded to the model');
  assert.equal(lines[lines.length - 1].type, 'result');
  assert.equal(lines[lines.length - 1].subtype, 'success');
});

test('openrouter run: per-run model override is honored', async () => {
  const r = await s.api('POST', '/run/start', {
    kind: 'skill', name: 'my-skill', task: 'quick check', provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    outputFile: join(s.home, 'runs', 'or2.jsonl'),
  });
  assert.equal(r.status, 200);
  const done = await waitForRun(r.data.id);
  const lines = readFileSync(done.file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines[0].model, 'openai/gpt-4o-mini', 'system event records the chosen model');
  const assistant = lines.find(l => l.type === 'assistant');
  assert.match(assistant.message.content[0].text, /model=openai\/gpt-4o-mini/, 'override model sent to OpenRouter');
});

test('GET /api/runs lists past runs; unknown run id -> 404', async () => {
  const { status, data } = await s.api('GET', '/runs');
  assert.equal(status, 200);
  assert.ok(data.length >= 3);
  assert.ok(data.every(x => x.running === false));
  assert.equal((await s.api('GET', '/run/nope')).status, 404);
  assert.equal((await s.api('POST', '/run/nope/stop', {})).status, 404);
});
