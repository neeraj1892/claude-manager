# Claude Manager — Test Suite & Bug Fixes

166 tests. Run with `npm test` (Node ≥18). Each test file boots an isolated server instance with its own temp `claudeDir`, temp `HOME` (isolated `~/.claude.json`), isolated config file, and a fake `claude` CLI shim on PATH that records every invocation — so no network access or real Claude Code install is needed.

## Bugs found and fixed

1. **Skill-creator option never used any skill-creator** — `GET /api/skills/creators` was registered *after* `GET /api/skills/:name`, so Express matched "creators" as a skill name and the endpoint always returned 404. The UI silently fell back to the built-in prompt. Route moved before `:name`. *(skills.test.js)*
2. **Installed official skill-creator ignored** — the hardcoded built-in methodology was always listed first. Now an installed `skills/skill-creator` is detected, listed first, and used by default. *(skills.test.js, ai-generation.test.js)*
3. **Dead `endsWithRequest` check** — `creatorContent.trimEnd().endsWith('Request: ')` could never be true (`trimEnd` strips the trailing space), so official creator content got double-wrapped with a duplicate `Request:` block. *(ai-generation.test.js)*
4. **Claude Code plugin marketplaces uninstallable** — sources pointing at `.claude-plugin/marketplace.json` produce entries with `source` but no npm package/MCP config, so no install command was generated and both install buttons were hidden. Now generates `claude plugin marketplace add <repo> && claude plugin install <name>@<marketplace>`. *(marketplace.test.js)*
5. **Install endpoint rejected `claude plugin install`** — only `claude mcp add` was allowed. Now allows `&&`-chained `claude mcp add` / `claude plugin install` / `claude plugin marketplace add`; everything else still rejected. *(marketplace.test.js)*
6. **Installed plugins missing from the list** — `/api/plugins` only read `plugins/installed_plugins.json` + `settings.json mcpServers`. It now also merges `settings.json enabledPlugins` (written by `claude plugin install`) and MCP servers from the global `~/.claude.json` (written by `claude mcp add`). *(plugins.test.js)*
7. **"✓ Added" badge never showed for npm/custom sources** — installed detection compared the source-prefixed card id against MCP server keys. Now matches server id, name, package name, and names extracted from the install command, across both config files. *(marketplace.test.js)*
8. **Plugin toggle no-op on first click** — toggle flipped `settings.enabledPlugins[id]` from `undefined` instead of the effective displayed state. *(plugins.test.js)*
9. **MCP remove only checked settings.json** — now also removes servers from `~/.claude.json`. *(plugins.test.js)*
10. **Installed Plugins tab stale after install** — frontend now refreshes the list after a successful install (app.js `_markInstallDone`).
11. **Frontmatter parser dropped hyphenated keys** (`argument-hint` etc.) — key regex widened.
12. **Install modal warned "claude may not be installed"** for `claude plugin …` commands — now recognizes all runnable claude commands (app.js).

## Test files

| File | Covers |
|---|---|
| `skills.test.js` | Skills CRUD, validation, traversal, creators endpoint regressions |
| `plugins.test.js` | Installed plugins merging from all 3 config locations, toggle, MCP removal |
| `marketplace.test.js` | Custom sources (Claude plugin + MCP fixtures via local HTTP server), install command generation/validation/execution, direct-install, installed-badge detection |
| `ai-generation.test.js` | Skill/agent/hook/workflow generation via CLI shim, creatorContent handling, provider validation |
| `hooks-agents-commands.test.js` | Hooks CRUD + event wiring, agents, commands, settings, CLAUDE.md, keybindings, overview, folder switching |
| `stores.test.js` | Skill/agent/hook store source CRUD, validation, install input sanitization |
| `run.test.js` | One-shot runner: skills/agents/commands/workflows → JSONL streaming, run/info (argument discovery + manual command), OpenRouter text-only provider (local fixture), validation, run history |
| `files.test.js` | Recursive hooks/agents discovery (nested + inside skills/plugins), generic file API (read/write/tree), traversal safety, settings.json parse-error surfacing |
