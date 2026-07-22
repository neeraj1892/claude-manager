# Claude Manager

A zero-dependency browser GUI for managing your [Claude Code](https://claude.ai/code) `~/.claude` configuration — skills, agents, hooks, commands, keybindings, settings, and more.

No build tools. No framework. Just `node server.js` and you're in.

---

## Features

### Core Management
| Section | What you can do |
|---------|----------------|
| **Overview** | Stats dashboard — counts, folder size, quick navigation |
| **CLAUDE.md** | Edit your global instructions with Monaco editor |
| **Settings** | Model picker, permissions (allow/deny), env vars, raw JSON editor |
| **Keybindings** | Edit keybindings.json with JSON validation |

### Skills
- Browse installed skills in a card grid with name, description, size, and modified date
- Create new skills from a template or **generate with AI** (Claude/OpenRouter)
- Edit skills in a full Monaco markdown editor
- Explain any skill — structured breakdown with scope, purpose, steps, and edge cases
- **Skill Store** — browse community skill repos (Anthropic official + community sources)
- Add/remove custom GitHub sources for skills

### Agents (Sub-agents)
- Same card-based UI as skills — browse, create, edit, delete, explain
- **Agent Store** — browse agents from curated GitHub repos (hooks-mastery, observability, addyosmani agent-skills)
- AI generation with domain and perspective/role context
- Multi-source support with custom GitHub repo addition

### Hooks
- View hook events (SessionStart, PreToolUse, PostToolUse, Stop, etc.) with registered commands
- Add/edit/delete hook commands per event, with matcher support for tool-name filtering
- Edit hook files (`.mjs`, `.py`, `.sh`) in Monaco with syntax highlighting
- Explain any hook command — understand what it does without reading the code
- **Hook Store** — browse hooks from hooks-mastery and multi-agent-observability repos
- **AI Hook Generation** — generate hooks in Node.js (ESM), Python 3, or Bash/Shell
  - Optionally wire the generated hook directly to a lifecycle event on save
  - Supports matcher patterns for PreToolUse/PostToolUse tool filtering

### Plugins
- View installed MCP plugins with version, status, and last-updated
- Enable/disable plugins via toggle (writes to `settings.json`)

### Marketplace / Stores (Skills · Agents · Hooks)
- Browse multiple GitHub sources per store type
- Search by name, filter by source
- One-click install into your `~/.claude` folder
- Add unlimited custom GitHub sources (owner/repo + path + extension)
- Sources persist across restarts in `claude-manager.config.json`

### AI Generation (Skills · Agents · Hooks · Workflows)
- Dual provider: **Claude** (via `claude` CLI) or **OpenRouter** (API key)
- Optional context fields: **Domain** and **Perspective/Role** for sharper output
- Skill-creator method selector: standard generation or Anthropic's official methodology guide
- Improve existing skills/agents with a dedicated improvement prompt
- Workflow wizard: 4-step guided workflow generation with component breakdown and install

---

## Requirements

- **Node.js ≥ 18**
- **Claude Code CLI** — optional, needed for Claude-powered AI generation (`claude` must be in PATH)
- **OpenRouter API key** — optional alternative for AI generation (entered in-app, saved to config)

---

## Installation

```bash
git clone https://github.com/your-username/claude-manager.git
cd claude-manager
node server.js
```

Dependencies (`express`) are auto-installed on first run if missing.

Then open **http://localhost:3000** in your browser.

---

## Usage

### Basic

```bash
node server.js                        # uses ~/.claude by default
node server.js /path/to/.claude       # use a different folder
CLAUDE_DIR=~/work/.claude node server.js
PORT=8080 node server.js              # custom port
```

### npm start

```bash
npm start
```

### The folder picker

Click the pencil icon next to the folder path in the header to switch to any `.claude` directory without restarting the server. The choice is saved to `claude-manager.config.json`.

---

## Configuration

Runtime config is stored in `claude-manager.config.json` (auto-created, git-ignored):

```json
{
  "claudeDir": "/Users/you/.claude",
  "openRouterKey": "sk-or-...",
  "agentSources": [],
  "hookSources": [],
  "skillSources": []
}
```

You never need to edit this file manually — the UI manages it.

---

## AI Generation Setup

### Option 1 — Claude CLI (recommended)
If `claude` is in your PATH, Claude-powered generation works out of the box. Select **Claude** in the provider picker inside any generator modal.

### Option 2 — OpenRouter
1. Get an API key from [openrouter.ai](https://openrouter.ai)
2. In any generator modal, select **OpenRouter** and paste your key
3. The key is saved to `claude-manager.config.json` for future sessions

---

## Skill / Agent / Hook Generation Tips

- **Domain** (optional): e.g. `"backend API design"`, `"data engineering"`, `"DevOps/Kubernetes"` — narrows the output vocabulary
- **Perspective** (optional): e.g. `"senior TypeScript engineer"`, `"security auditor"` — shapes the tone and assumptions
- **Hook language**: choose Node.js ESM (`.mjs`), Python 3 (`.py`), or Bash (`.sh`) — each generates idiomatic starter code with correct stdin-reading patterns
- **Wire to event**: after generating a hook, enable the checkbox to register it in `settings.json` immediately

---

## Community Sources (pre-configured)

### Skill Store
| Source | Description |
|--------|-------------|
| Anthropic Official Skills | Official skills from `anthropics/claude-code-skills` |

### Agent Store
| Source | Description |
|--------|-------------|
| Hooks Mastery Agents | `disler/claude-code-hooks-mastery` — `.claude/agents/` |
| Observability Agents | `disler/claude-code-hooks-multi-agent-observability` — `.claude/agents/` |
| Agent Skills (addyosmani) | `addyosmani/agent-skills` — agents directory |

### Hook Store
| Source | Description |
|--------|-------------|
| Hooks Mastery | `disler/claude-code-hooks-mastery` — Python hooks |
| Multi-Agent Observability | `disler/claude-code-hooks-multi-agent-observability` — Python hooks |

Add your own GitHub repos from the "Manage Sources" panel in each store tab.

---

## Architecture

```
claude-manager/
├── server.js          # Express API + static serving (CommonJS, no transpilation)
├── package.json
├── public/
│   ├── index.html     # App shell — sidebar + content pane
│   ├── app.js         # SPA router + all section renderers (vanilla JS)
│   └── styles.css     # Design system — CSS variables, layout, components
└── claude-manager.config.json   # Runtime config (git-ignored)
```

**Backend**: Node.js + Express. All writes are atomic (write temp → rename). Paths are resolved relative to `claudeDir` with traversal protection.

**Frontend**: Vanilla JS SPA with [Monaco Editor](https://microsoft.github.io/monaco-editor/) via CDN for all code/markdown editing. No bundler, no framework, no build step.

**Storage**: Filesystem only. The app reads and writes your `.claude` directory directly.

---

## API Reference

```
GET  /api/status                   → { valid, path, stats }
POST /api/folder                   → { path }
GET  /api/overview                 → counts per section

GET/PUT  /api/claude-md            → CLAUDE.md content
GET/PUT  /api/settings             → settings.json
GET/PUT  /api/keybindings          → keybindings.json

GET/POST             /api/skills
GET/PUT/DELETE       /api/skills/:name
GET/POST             /api/agents
GET/PUT/DELETE       /api/agents/:name
GET/POST/PUT/DELETE  /api/hooks/files/:name
GET/PUT              /api/hooks/events

GET/POST/DELETE      /api/skill-sources
GET                  /api/skill-store/browse
POST                 /api/skill-store/install

GET/POST/DELETE      /api/agent-sources
GET                  /api/agent-store/browse
POST                 /api/agent-store/install

GET/POST/DELETE      /api/hook-sources
GET                  /api/hook-store/browse
POST                 /api/hook-store/install

POST  /api/ai/generate-skill       → AI-generated skill/agent/hook content
POST  /api/ai/improve-skill        → AI-improved version of existing content
POST  /api/ai/explain              → Structured explanation of any artifact
POST  /api/ai/generate-workflow    → Workflow plan generation
```

---

## Contributing

1. Fork the repo
2. Make your changes (server.js + public/)
3. Test with `node server.js` against your own `~/.claude`
4. Submit a PR with a description of what changed and why

No build step needed — just edit and reload.

---

## License

[MIT](LICENSE)
