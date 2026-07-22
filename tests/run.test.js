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
  assert.ok(data.manualCommand.startsWith('cd '), 'manual command sets the working directory first');
  assert.ok(data.manualCommand.includes("<< 'PROMPT'"), 'prompt passed via heredoc (no quoting pitfalls)');
  assert.ok(data.manualCommand.includes('--dangerously-skip-permissions'));
  assert.ok(data.manualCommand.includes('/my-skill'));
});

test('run/info ?shell=powershell returns a Windows-correct command', async () => {
  const { data } = await s.api('GET', '/run/info?kind=skill&name=my-skill&shell=powershell');
  const cmd = data.manualCommand;
  assert.ok(cmd.includes("@'"), 'PowerShell here-string used');
  assert.ok(cmd.includes('Out-File -Encoding utf8'), 'UTF-8 safe output redirection');
  assert.ok(cmd.includes('`'), 'backtick line continuations');
  assert.ok(!cmd.includes("<< 'PROMPT'"), 'no POSIX heredoc');
  assert.ok(!/\\\n/.test(cmd), 'no backslash continuations');
  // and bash stays bash when requested explicitly
  const bash = await s.api('GET', '/run/info?kind=skill&name=my-skill&shell=bash');
  assert.ok(bash.data.manualCommand.includes("<< 'PROMPT'"));
});

test('run/info for agents reads the agent definition', async () => {
  mkdirSync(join(s.claudeDir, 'agents'), { recursive: true });
  writeFileSync(join(s.claudeDir, 'agents', 'auditor.md'),
    '---\nname: auditor\ndescription: Audits code for security issues.\n---\nBody');
  const { status, data } = await s.api('GET', '/run/info?kind=agent&name=auditor');
  assert.equal(status, 200);
  assert.equal(data.exists, true);
  assert.match(data.description, /Audits code/);
  assert.ok(data.manualCommand.includes('agents'), 'manual command references the agent definition');
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

test('expected output: stated as a contract in the prompt for every kind + provider', async () => {
  // skill via CLI
  let r = await s.api('POST', '/run/start', {
    kind: 'skill', name: 'my-skill', task: 'review PR 7',
    expectedOutput: 'a severity-ranked markdown table in REVIEW.md',
    outputFile: join(s.home, 'runs', 'exp1.jsonl'), cwd: s.home,
  });
  await waitForRun(r.data.id);
  let prompt = s.readShimPrompt();
  assert.ok(prompt.startsWith('/my-skill review PR 7'), 'invocation intact');
  assert.match(prompt, /EXPECTED OUTPUT[\s\S]*severity-ranked markdown table in REVIEW\.md/, 'contract as its own block');

  // agent via CLI
  r = await s.api('POST', '/run/start', {
    kind: 'agent', name: 'reviewer', task: 'audit src', expectedOutput: 'JSON array of {file, issue}',
    outputFile: join(s.home, 'runs', 'exp2.jsonl'), cwd: s.home,
  });
  await waitForRun(r.data.id);
  assert.match(s.readShimPrompt(), /EXPECTED OUTPUT[\s\S]*JSON array/, 'agent runs carry the contract');

  // OpenRouter text-only runs carry it too
  await s.api('PUT', '/ai-config', { openRouterKey: 'sk-x' });
  r = await s.api('POST', '/run/start', {
    kind: 'skill', name: 'my-skill', task: 'summarize', provider: 'openrouter',
    expectedOutput: 'three bullet points max',
    outputFile: join(s.home, 'runs', 'exp3.jsonl'),
  });
  const done = await waitForRun(r.data.id);
  const assistant = JSON.parse(readFileSync(done.file, 'utf8').trim().split('\n').find(l => l.includes('assistant')) || '{}');
  assert.match(assistant.message.content[0].text, /EXPECTED OUTPUT[\s\S]*three bullet points max/, 'OR prompt includes the contract');

  // Without the field, no contract text leaks into the prompt
  r = await s.api('POST', '/run/start', {
    kind: 'skill', name: 'my-skill', task: 'plain',
    outputFile: join(s.home, 'runs', 'exp4.jsonl'), cwd: s.home,
  });
  await waitForRun(r.data.id);
  assert.ok(!s.readShimPrompt().includes('EXPECTED OUTPUT'), 'optional means absent when empty');

  // restore: later tests assert behavior without a saved key
  await s.api('PUT', '/ai-config', { openRouterKey: '' });
});

test('CLI run: optional --model pin is passed through; default runs stay unpinned', async () => {
  const r = await s.api('POST', '/run/start', {
    kind: 'skill', name: 'my-skill', task: 'x', model: 'sonnet',
    outputFile: join(s.home, 'runs', 'model-pin.jsonl'), cwd: s.home,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const done = await waitForRun(r.data.id);
  assert.equal(done.model, 'sonnet', 'run record carries the model');
  assert.ok(s.readShimArgs().includes('--model sonnet'), 'claude invoked with --model: ' + s.readShimArgs());

  const r2 = await s.api('POST', '/run/start', {
    kind: 'skill', name: 'my-skill', task: 'y',
    outputFile: join(s.home, 'runs', 'no-pin.jsonl'), cwd: s.home,
  });
  await waitForRun(r2.data.id);
  assert.ok(!s.readShimArgs().includes('--model'), 'no --model without a pin');

  const bad = await s.api('POST', '/run/start', {
    kind: 'skill', name: 'my-skill', model: 'evil; rm -rf /',
    outputFile: join(s.home, 'runs', 'bad-model.jsonl'), cwd: s.home,
  });
  assert.equal(bad.status, 400, 'model name sanitized');
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
  // The fixture endpoint can transiently refuse under parallel test load —
  // retry the whole run once before failing.
  let lines, assistant;
  for (let attempt = 0; attempt < 3 && !assistant; attempt++) {
    const r = await s.api('POST', '/run/start', {
      kind: 'skill', name: 'my-skill', task: 'quick check', provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      outputFile: join(s.home, 'runs', `or2-${attempt}.jsonl`),
    });
    assert.equal(r.status, 200);
    const done = await waitForRun(r.data.id);
    lines = readFileSync(done.file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assistant = lines.find(l => l.type === 'assistant');
  }
  assert.equal(lines[0].model, 'openai/gpt-4o-mini', 'system event records the chosen model');
  assert.ok(assistant, 'assistant event present after retries: ' + JSON.stringify(lines.slice(-1)));
  assert.match(assistant.message.content[0].text, /model=openai\/gpt-4o-mini/, 'override model sent to OpenRouter');
});

test('workflow run with empty task falls back to a sensible default prompt', async () => {
  const r = await s.api('POST', '/run/start', {
    kind: 'workflow', name: 'Smart Commit', task: '', outputFile: join(s.home, 'runs', 'wf-default.jsonl'), cwd: s.home,
  });
  await waitForRun(r.data.id);
  assert.match(s.readShimPrompt(), /Execute the "Smart Commit" workflow/);
});

test('agent run with empty task uses the default-responsibility prompt', async () => {
  const r = await s.api('POST', '/run/start', {
    kind: 'agent', name: 'reviewer', task: '', outputFile: join(s.home, 'runs', 'agent-default.jsonl'), cwd: s.home,
  });
  await waitForRun(r.data.id);
  assert.match(s.readShimPrompt(), /default responsibility/);
});

test('stop on an already-finished run is a harmless no-op', async () => {
  const r = await s.api('POST', '/run/start', {
    kind: 'skill', name: 'my-skill', task: 'x', outputFile: join(s.home, 'runs', 'stop-late.jsonl'), cwd: s.home,
  });
  await waitForRun(r.data.id);
  const stop = await s.api('POST', `/run/${r.data.id}/stop`, {});
  assert.equal(stop.status, 200);
  const after_ = await s.api('GET', '/run/' + r.data.id);
  assert.equal(after_.data.exitCode, 0, 'finished run not marked as errored by a late stop');
});

test('GET /api/runs lists past runs; unknown run id -> 404', async () => {
  const { status, data } = await s.api('GET', '/runs');
  assert.equal(status, 200);
  assert.ok(data.length >= 3);
  assert.ok(data.every(x => x.running === false));
  assert.equal((await s.api('GET', '/run/nope')).status, 404);
  assert.equal((await s.api('POST', '/run/nope/stop', {})).status, 404);
});
