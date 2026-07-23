# Claude Manager

A local, browser-based control center for **Claude Code's `~/.claude` folder** — manage skills, agents, hooks, commands, plugins, MCP servers, and workflows through a clean Apple-style UI instead of hand-editing markdown and JSON files.

Zero build step. One dependency (Express). Runs entirely on your machine.

---

## Why

Claude Code is configured through a growing collection of files: `SKILL.md` files in `skills/`, agent definitions in `agents/`, hook scripts wired into `settings.json`, slash commands in `commands/`, MCP servers split across `settings.json` and `~/.claude.json`, and plugins recorded in yet more places. Keeping all of that correct by hand is error-prone, and it's hard to even *see* what's installed.

Claude Manager puts all of it in one place: browse it, edit it, understand it (with AI explanations), generate new pieces (with AI), test-run things one-shot, and install more from marketplaces — without ever touching raw config unless you want to.

## Features

### Manage everything in `~/.claude`
- **Skills** — create, edit, delete; a **📂 Files explorer** opens every nested file of a skill (scripts, references, bundled hooks) for editing or AI explanation.
- **Agents** — full CRUD, including agents nested in subfolders and agents shipped inside installed plugins.
- **Custom Events** — Claude Code cannot fire new runtime events, but the 🧬 Custom Event Creator derives them: describe a condition ("when Claude pushes to git"), the AI picks the right built-in event, writes a fail-open detector script, wires it into settings.json, and registers it with a name and description.
- **Hooks** — hook files (Node/Python/Bash/PowerShell) plus the lifecycle-event wiring in `settings.json`; also surfaces hook/script files living *inside* skills and plugins. Broken `settings.json`? The parse error is shown instead of a silently empty tab.
- **Commands** — slash-command markdown files with full CRUD.
- **CLAUDE.md, settings.json, keybindings.json** — direct editors with validation.

### Plugins & MCP servers
- Installed list merges **every** source Claude Code uses: `plugins/installed_plugins.json`, `settings.json → enabledPlugins`, `settings.json → mcpServers`, and the global `~/.claude.json` (user *and* local/project scope).
- Per-plugin **description**, **enable/disable**, **update**, **reinstall**, **remove** — plus summary counts.
- **＋ Add MCP Server**: a guided form (name, command/args/env or remote URL) — no raw JSON required.
- **Marketplace**: curated official MCP servers, live NPM registry search, and custom sources — including **Claude Code plugin marketplaces** (`.claude-plugin/marketplace.json`), installed via `claude plugin marketplace add … && claude plugin install …` in one click.
- Skill Store / Agent Store / Hook Store: install from GitHub repos (official Anthropic skills repo built in; add any public repo as a source).

### AI generation (Claude CLI or OpenRouter)
- Generate **skills, agents, hooks (Node/Python/Bash), and commands** from a plain-language description, with curated system prompts and validation.
- Uses your **installed `skill-creator` skill** when present (falls back to a built-in methodology).
- **Improve** and **Explain** any artifact with one click.
- **Workflows**: generate a full multi-component workflow from a goal, or use **🧬 Compose from Installed** — the AI checks whether your goal is achievable with what you already have, lists which installed pieces to use, what's missing (one-click generate), and how to wire it up. Every claim is verified against disk, so it never reports something as installed when it isn't.

### One-shot runs → JSONL
Every skill, agent, command, and workflow has a **▶ Run** button:
- Shows what the artifact does and what arguments it accepts (from its frontmatter).
- Choose the working directory, the output `.jsonl` path, and an optional **expected output** — stated as a contract in the prompt ("the run is only complete when it delivers exactly this").
- **Claude CLI provider**: full run via `claude -p --dangerously-skip-permissions --output-format stream-json` with an optional `--model` pin (sonnet/opus/haiku or a pinned version), streaming every event to your JSONL file with a live tail, stop button, and 15-minute timeout.
- **OpenRouter provider**: text-only dry-run using your key and chosen model (no tool execution) — works even without Claude Code installed.
- Prefer the terminal? The modal shows the exact copy-paste command in your shell's dialect — bash/zsh heredoc or Windows PowerShell here-string (auto-detected from the server OS, toggleable).

## Setup

Requirements: **Node.js ≥ 18**. Optional: [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) for one-shot runs and CLI-based AI generation; an [OpenRouter](https://openrouter.ai) API key as the alternative AI provider.

```bash
git clone git@github.com:neeraj1892/claude-manager.git
cd claude-manager
npm install
npm start
```

The app opens at **http://localhost:3000** and manages `~/.claude` by default.

Point it at a different folder:

```bash
node server.js /path/to/.claude       # CLI argument
CLAUDE_DIR=/path/to/.claude npm start # environment variable
PORT=3001 npm start                   # different port
```

The folder choice persists in `claude-manager.config.json` (gitignored). Your OpenRouter key is stored **outside the repo** in `~/.claude-manager.secrets.json` (chmod 600) so it can never be committed; keys found in older configs are migrated out automatically.

## Usage tour

| Section | What you do there |
|---|---|
| **Overview** | Stats, how-the-pieces-fit concept map, guided first moves, system status |
| **Skills / Agents / Commands** | Cards with Run, Files, Explain, Improve, Edit, Delete; store tabs to install more |
| **Hooks** | Hook files + event wiring; template gallery; AI generation; "elsewhere" panel for hooks inside skills/plugins |
| **Plugins** | Installed list with counts/descriptions/actions; marketplace with custom sources; guided MCP add |
| **Workflows** | Pre-built templates, AI-created workflows, Compose-from-Installed, one-shot workflow runs |
| **Examples** | Annotated real-world examples — copy or install with one click |
| **CLAUDE.md / Settings / Keybindings** | Direct editors |

### Customizable prompts
Settings → Prompts lists every system prompt the app sends to the AI (skill/agent/hook/command generation, improve, explain, workflow planning, compose, custom events, settings assistant). Edit any of them to impose your own conventions — your version is used everywhere that feature runs; template prompts keep their `{{TOKENS}}` (validated on save); reset restores the built-in.

### Configuring AI providers
Any modal with a provider picker (Generate, Run, Compose) auto-detects: if the Claude CLI is available it's preselected; otherwise OpenRouter is selected with its key + model fields shown inline. Keys are saved once and reused everywhere.

## Testing

```bash
npm test
```

245 tests (Node's built-in `node --test`) covering every endpoint and scenario. Each test file boots an isolated server with its own temp `.claude` folder, temp `HOME`, isolated config, a local fixture marketplace/OpenRouter endpoint, and a fake `claude` CLI shim that records invocations — no network or real Claude Code install needed. See [`tests/README.md`](tests/README.md) for the full bug-fix history and scenario list.

## Security notes

- The server binds to localhost and is meant for **local, single-user** use.
- File APIs are path-traversal-guarded and scoped to the managed `.claude` folder.
- Marketplace installs only execute `claude mcp add` / `claude plugin …` commands — anything else is rejected (copy it and run manually instead).
- One-shot CLI runs use `--dangerously-skip-permissions`: Claude can edit files and run commands in the chosen working directory without asking. The UI warns you; only run artifacts you trust.

## Project structure

```
server.js        # Express server — all API endpoints, AI prompts, runners
public/
  index.html     # single-page UI
  app.js         # UI logic
  styles.css     # design system (Apple HIG system colors, dark/light)
tests/           # node --test suite (isolated server per file)
```

## License

MIT — see [LICENSE](LICENSE).
