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
    if (req.method === 'GET' && req.url === '/example.md') {
      res.setHeader('Content-Type', 'text/plain');
      return res.end('EXAMPLE_REFERENCE_CONTENT: a great workflow does X then Y.');
    }
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

test('generate-workflow-plan returns parsed JSON plan with hook wiring info', async () => {
  const { status, data } = await s.api('POST', '/ai/generate-workflow-plan', { goal: 'automate PR reviews', provider: 'claude-cli' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.name, 'test-workflow');
  assert.ok(Array.isArray(data.components) && data.components.length >= 1);
  const hook = data.components.find(c => c.type === 'hook');
  assert.ok(hook, 'plan includes a hook component');
  assert.equal(hook.event, 'PreToolUse', 'hook carries its wiring event');
  assert.equal(hook.matcher, 'Bash');
  // The plan prompt itself demands event/matcher for hooks
  assert.ok(s.readShimPrompt().includes('EVERY hook component MUST include "event"'));
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

// ── MCP/plugin references + reference link in workflow flows ──

test('compose-workflow: selected MCPs/plugins and reference link reach the AI prompt', async () => {
  const { writeFileSync, mkdirSync } = require('fs');
  const { join } = require('path');
  // Install an MCP server + a plugin record so refs resolve with descriptions
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({
    mcpServers: { 'github-mcp': { type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'] } },
    enabledPlugins: { 'pony@ponytail': true },
  }));
  const { status, data } = await s.api('POST', '/ai/compose-workflow', {
    goal: 'sync issues to reviews',
    provider: 'claude-cli',
    mcpRefs: ['github-mcp', 'pony@ponytail'],
    referenceUrl: `http://127.0.0.1:${OR_PORT}/example.md`,
  });
  assert.equal(status, 200, JSON.stringify(data));
  const prompt = s.readShimPrompt();
  assert.ok(prompt.includes('AVAILABLE MCP SERVERS / PLUGINS'), 'refs block present');
  assert.ok(prompt.includes('github-mcp (mcp)'), 'MCP ref listed with kind');
  assert.ok(prompt.includes('pony@ponytail (plugin)'), 'plugin ref listed');
  assert.ok(prompt.includes('EXAMPLE_REFERENCE_CONTENT'), 'reference link content fetched into prompt');
  assert.ok(prompt.includes('/example.md'), 'reference source URL cited');
});

test('generate-workflow-plan: refs and reference link included too', async () => {
  const { status } = await s.api('POST', '/ai/generate-workflow-plan', {
    goal: 'automate PR reviews',
    provider: 'claude-cli',
    mcpRefs: ['github-mcp'],
    referenceUrl: `http://127.0.0.1:${OR_PORT}/example.md`,
  });
  assert.equal(status, 200);
  const prompt = s.readShimPrompt();
  assert.ok(prompt.includes('github-mcp (mcp)'));
  assert.ok(prompt.includes('EXAMPLE_REFERENCE_CONTENT'));
  assert.ok(prompt.trimEnd().endsWith('Goal: automate PR reviews'), 'goal stays last');
});

test('reference link validation: invalid and unreachable URLs -> 400', async () => {
  const bad = await s.api('POST', '/ai/compose-workflow', { goal: 'x', provider: 'claude-cli', referenceUrl: 'not-a-url' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Invalid reference URL/);
  const dead = await s.api('POST', '/ai/compose-workflow', { goal: 'x', provider: 'claude-cli', referenceUrl: 'http://127.0.0.1:59322/gone.md' });
  assert.equal(dead.status, 400);
  assert.match(dead.data.error, /Could not fetch/);
  const ftp = await s.api('POST', '/ai/compose-workflow', { goal: 'x', provider: 'claude-cli', referenceUrl: 'ftp://example.com/x' });
  assert.equal(ftp.status, 400);
});

test('unknown mcpRef names still pass through (listed without description)', async () => {
  const { status } = await s.api('POST', '/ai/compose-workflow', {
    goal: 'y', provider: 'claude-cli', mcpRefs: ['not-installed-mcp'],
  });
  assert.equal(status, 200);
  assert.ok(s.readShimPrompt().includes('not-installed-mcp (mcp)'));
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

test('REGRESSION: chat-escaped CLI output (\\--- &#x20; \\#) is unescaped, frontmatter survives', async () => {
  const { status, data } = await s.api('POST', '/ai/generate-skill', { prompt: 'ESCAPED_TEST repo skill', provider: 'claude-cli', type: 'skill' });
  assert.equal(status, 200, JSON.stringify(data));
  const c = data.content;
  assert.ok(c.startsWith('---\nname: repo-understand'), 'fence unescaped, frontmatter intact: ' + JSON.stringify(c.slice(0, 40)));
  assert.ok(!c.includes('\\---'), 'no escaped fences remain');
  assert.ok(!c.includes('&#x20;'), 'no HTML-entity spaces remain');
  assert.ok(!c.includes('\\#') && !c.includes('\\_') && !c.includes('\\*'), 'punctuation unescaped');
  assert.ok(c.includes('when_to_use:'), 'underscored keys restored');
  assert.ok(c.includes('mcp__codebase'), 'double underscores restored');
  assert.ok(c.includes('# Repo Understand') && c.includes('## Steps'), 'headings restored');
  // saved file parses: description shows on the card
  const save = await s.api('POST', '/skills', { name: 'escaped-fixture', content: c });
  assert.equal(save.status, 201);
  const list = await s.api('GET', '/skills');
  const item = list.data.find(x => x.name === 'escaped-fixture');
  assert.match(item.description, /Deep-dives a repository/, 'card description parses correctly');
});

test('skills list surfaces allowed-tools / disallowed-tools (incl. Bash(...) rules)', async () => {
  const { mkdirSync, writeFileSync } = require('fs');
  const { join } = require('path');
  mkdirSync(join(s.claudeDir, 'skills', 'permitted-skill'), { recursive: true });
  writeFileSync(join(s.claudeDir, 'skills', 'permitted-skill', 'SKILL.md'),
    '---\nname: permitted-skill\ndescription: does things\nallowed-tools: Read Grep Bash(git add *) Bash(git commit *)\ndisallowed-tools: Write, Edit\n---\nBody');
  const { data } = await s.api('GET', '/skills');
  const it = data.find(x => x.name === 'permitted-skill');
  assert.deepEqual(it.allowedTools, ['Read', 'Grep', 'Bash(git add *)', 'Bash(git commit *)'],
    'space-separated rules with parenthesised args parsed: ' + JSON.stringify(it.allowedTools));
  assert.deepEqual(it.disallowedTools, ['Write', 'Edit'], 'comma-separated form parsed');
});

test('skill generation prompt teaches allowed-tools; agent prompt teaches permissionMode', async () => {
  await s.api('POST', '/ai/generate-skill', { prompt: 'x', provider: 'claude-cli', type: 'skill' });
  assert.ok(s.readShimPrompt().includes('allowed-tools:'), 'skill prompt documents allowed-tools');
  await s.api('POST', '/ai/generate-skill', { prompt: 'y', provider: 'claude-cli', type: 'agent' });
  const p = s.readShimPrompt();
  assert.ok(p.includes('permissionMode:') && p.includes('disallowedTools:'), 'agent prompt documents permission fields');
});

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

// ── Meta-prompt audit: consistency layer, context discipline, event catalog ──

test('generation prompts carry the consistency rule and context discipline', async () => {
  await s.api('POST', '/ai/generate-skill', { prompt: 'a', provider: 'claude-cli', type: 'skill' });
  let p = s.readShimPrompt();
  assert.ok(p.includes('CONSISTENCY RULE'), 'skill prompt: body ⇄ allowed-tools rule');
  assert.ok(p.includes('CONTEXT DISCIPLINE'), 'skill prompt: bake-vs-adapt guidance');
  assert.ok(p.includes('LARGER AUTONOMOUS SKILLS'), 'skill prompt: second structural tier');
  await s.api('POST', '/ai/generate-skill', { prompt: 'b', provider: 'claude-cli', type: 'agent' });
  p = s.readShimPrompt();
  assert.ok(p.includes('CONSISTENCY RULE') && p.includes('mcpServers'), 'agent prompt: rule + mcpServers field');
  await s.api('POST', '/ai/generate-skill', { prompt: 'c', provider: 'claude-cli', type: 'command' });
  p = s.readShimPrompt();
  assert.ok(p.includes('CONSISTENCY RULE') && p.includes('disable-model-invocation'), 'command prompt: rule + new fields');
});

test('hook prompts teach the FULL event catalog (was 4 of 19)', async () => {
  for (const [lang, marker] of [['.mjs', 'ESM JavaScript'], ['.py', 'Python 3 hooks'], ['.sh', 'Bash shell hooks']]) {
    await s.api('POST', '/ai/generate-skill', { prompt: 'evt probe', provider: 'claude-cli', type: 'hook', hookLang: lang });
    const p = s.readShimPrompt();
    assert.ok(p.includes(marker), lang + ' prompt used');
    assert.ok(p.includes('UserPromptSubmit') && p.includes('SessionEnd') && p.includes('PreCompact'),
      lang + ': full catalog injected');
    assert.ok(!p.includes('{{EVENTS}}'), lang + ': token replaced');
  }
});

test('full workflow generation demands grants on components', async () => {
  await s.api('POST', '/ai/generate-workflow', { goal: 'g', provider: 'claude-cli' });
  assert.ok(s.readShimPrompt().includes('allowed-tools/tools MUST list every tool'),
    'workflow-generated skills carry pre-approval grants');
});

test('improve is type-aware and re-injects the consistency rule', async () => {
  await s.api('POST', '/ai/improve-skill', { content: '#!/usr/bin/env node\nx', provider: 'claude-cli', type: 'hook' });
  let p = s.readShimPrompt();
  assert.ok(p.includes('stop_hook_active'), 'hook improve checks hook laws');
  assert.ok(!p.includes('sharpen trigger phrases'), 'hook improve no longer told to sharpen trigger phrases');
  await s.api('POST', '/ai/improve-skill', { content: '---\nname: x\n---\nb', provider: 'claude-cli', type: 'skill' });
  assert.ok(s.readShimPrompt().includes('CONSISTENCY CHECK'), 'skill improve can now fix grant mismatches');
});

test('creator paths are hardened too (methodology body untouched)', async () => {
  const creators = await s.api('GET', '/skills/creators');
  const builtin = creators.data.find(c => (c.content || '').includes('Official Skill-Creator Methodology'));
  assert.ok(builtin, 'builtin methodology listed');
  assert.ok(builtin.content.includes('Claude Code Additions (app addendum'), 'addendum appended');
  assert.ok(builtin.content.includes('allowed-tools'), 'addendum teaches allowed-tools');
  assert.ok(builtin.content.includes('NEVER backslash-escape'), 'builtin tail carries the output contract');
  assert.ok(builtin.content.includes('slightly "pushy"'), 'original methodology text preserved');
  await s.api('POST', '/ai/generate-skill', {
    prompt: 'w', provider: 'claude-cli', type: 'skill',
    creatorContent: '---\nname: c\n---\nCustom methodology with skill-creation guidance.',
  });
  const p = s.readShimPrompt();
  assert.ok(p.includes('NEVER backslash-escape'), 'creator wrapper carries anti-escape rule');
  assert.ok(p.includes('lists every tool the body uses'), 'creator wrapper carries consistency rule');
});

test('compose inventory: hooks carry description + wiredTo; settings catalog current', async () => {
  await s.api('POST', '/hooks/files', { name: 'inv-probe.mjs', content: '#!/usr/bin/env node\n// Blocks accidental force pushes to main\nprocess.exit(0);\n' });
  await s.api('POST', '/hooks/wire', { event: 'PreToolUse', matcher: 'Bash', filename: 'inv-probe.mjs' });
  await s.api('POST', '/ai/compose-workflow', { goal: 'guard pushes', provider: 'claude-cli' });
  const p = s.readShimPrompt();
  assert.ok(p.includes('Blocks accidental force pushes'), 'hook first-comment surfaces as description');
  assert.ok(/inv-probe[\s\S]*?PreToolUse/.test(p), 'wiredTo events included');
  assert.ok(p.includes('already wired'), 'compose told not to re-wire');
  await s.api('POST', '/ai/suggest-settings', { request: 'hide the code-review skill', provider: 'claude-cli' });
  const sp = s.readShimPrompt();
  assert.ok(sp.includes('skillOverrides') && sp.includes('disableBundledSkills') && sp.includes('additionalDirectories'),
    'settings catalog includes current documented keys');
});

test('CLI generation is pinned to Opus (authoring quality over latency)', async () => {
  await s.api('POST', '/ai/generate-skill', { prompt: 'model pin probe', provider: 'claude-cli', type: 'skill' });
  assert.ok(s.readShimArgs().includes('--model opus'), 'generate uses opus: ' + s.readShimArgs());
  await s.api('POST', '/ai/improve-skill', { content: '---\nname: x\n---\nbody', provider: 'claude-cli', type: 'skill' });
  assert.ok(s.readShimArgs().includes('--model opus'), 'improve uses opus too');
});

// ── Meta-prompt review regressions (output contract, agent fields, hook wiring) ──

test('REGRESSION: agent prompt example no longer contains when_to_use (not an agent field)', async () => {
  await s.api('POST', '/ai/generate-skill', { prompt: 'an agent', provider: 'claude-cli', type: 'agent' });
  const p = s.readShimPrompt();
  assert.ok(!p.includes('when_to_use'), 'agents route via description; when_to_use is a skill field');
  assert.ok(p.includes('NEVER emit bypassPermissions unless the request explicitly asks'),
    'agent prompt defaults to safe permissions (Falkland)');
});

test('generation prompts carry the output contract: anti-escape rule + ambiguity channel', async () => {
  await s.api('POST', '/ai/generate-skill', { prompt: 'a skill', provider: 'claude-cli', type: 'skill' });
  let p = s.readShimPrompt();
  assert.ok(p.includes('NEVER backslash-escape markdown'), 'skill prompt forbids chat-style escaping at the source');
  assert.ok(p.includes('IF THE REQUEST IS AMBIGUOUS'), 'skill prompt has a defined uncertainty channel');
  assert.ok(!p.includes('violation means failure'), 'threat framing replaced by the contract');
  await s.api('POST', '/ai/generate-skill', { prompt: 'a hook', provider: 'claude-cli', type: 'hook', hookLang: '.mjs' });
  p = s.readShimPrompt();
  assert.ok(p.includes('FIVE LAWS'), 'hook prompt gained the Murphy law');
  assert.ok(p.includes('IF THE REQUEST IS AMBIGUOUS'), 'hook prompt has the uncertainty channel');
});

test('REGRESSION: full workflow generation prompt demands event/matcher for hooks', async () => {
  await s.api('POST', '/ai/generate-workflow', { goal: 'guard commits', provider: 'claude-cli' });
  const p = s.readShimPrompt();
  assert.ok(p.includes('EVERY hook component MUST include "event"'),
    'one-shot workflow prompt now supports auto-wiring (was missing, unlike the plan prompt)');
  assert.ok(p.includes('when_to_use, allowed-tools for skills'), 'stale "trigger" field name corrected + grants required');
  assert.ok(p.includes('VERIFY'), 'setup guide must end with a verification step (Gilbert)');
});

test('REGRESSION: improving a Python hook keeps its shebang (not corrupted to Node)', async () => {
  await s.api('POST', '/ai/improve-skill', {
    content: '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n', provider: 'claude-cli', type: 'hook',
  });
  const p = s.readShimPrompt();
  assert.ok(p.includes('Start with "#!/usr/bin/env python3"'), 'validation derived from the original shebang');
  assert.ok(!p.includes('Start with "#!/usr/bin/env node"'), 'node shebang not forced onto a python hook');
});

test('compose prompt allows an honest "no"; settings prompt has an empty-patch escape hatch', async () => {
  await s.api('POST', '/skills', { name: 'compose-skill', content: '---\nname: compose-skill\ndescription: d\n---\nbody' });
  await s.api('POST', '/ai/compose-workflow', { goal: 'INVENTORY OF INSTALLED RESOURCES probe', provider: 'claude-cli' });
  assert.ok(s.readShimPrompt().includes('"no" is a valid, honest answer'), 'compose may decline (Falkland)');
  await s.api('POST', '/ai/suggest-settings', { request: 'make claude sentient', provider: 'claude-cli' });
  assert.ok(s.readShimPrompt().includes('an empty patch is better than an invented key'),
    'settings prompt has a defined failure channel');
});
