# Claude Manager

**A local control center for Claude Code — browse, build, test, and repair everything in your `~/.claude` setup through a clean web UI instead of hand-editing a maze of config files.**

![tests](https://img.shields.io/badge/tests-250%20passing-brightgreen) ![node](https://img.shields.io/badge/node-%E2%89%A518-blue) ![deps](https://img.shields.io/badge/dependencies-1%20(express)-lightgrey) ![license](https://img.shields.io/badge/license-MIT-green)

Runs entirely on your machine. Zero build step. One dependency.

---

## The problem

Claude Code is configured through a growing sprawl of files: `SKILL.md` files in `skills/`, agent definitions in `agents/`, hook scripts wired into `settings.json`, slash commands in `commands/`, MCP servers split across **five** different config locations, and plugins recorded in yet more places.

This creates three real problems:

1. **You can't see what you have.** Installed MCP servers hide in `~/.claude.json`, plugin state lives in three files, and a hook that isn't wired to a lifecycle event silently never runs.
2. **Hand-editing is error-prone.** One YAML mistake and a skill loads with no metadata. A skill whose body uses tools its `allowed-tools` never grants stops for permission prompts at runtime — and nothing tells you why.
3. **Writing good skills is a craft.** The difference between a skill that triggers reliably and one that never fires is invisible unless you've read the docs deeply.

Claude Manager puts all of it in one place — and adds the guardrails, generators, and quality checks that the raw files can't give you.

## Why not just ask Claude, or use an editor?

**"Claude Code can already create skills."** It can *write* one when you ask. It can't be three things a chat fundamentally isn't:

- **An inventory.** A conversation has no persistent picture of your setup — the hook that's silently unwired, the MCP server hiding in a config file you forgot exists, the skill that will stall on permission prompts. A dashboard's job is that nothing stays invisible.
- **A pipeline.** Chat-generated quality varies with the conversation. Here every generation flows through the same hardened prompts and *deterministic* post-processing — tool-grant lint, auto-grant, escape/fence repair, a capped self-eval. Asking a talented colleague vs. having CI.
- **An operations panel.** Wiring hooks, marketplace installs, one-shot runs with output contracts, health metrics over time — operations on your setup, not documents.

**"I could edit these files in my IDE."** An editor edits text; it doesn't know Claude Code's *semantics*. No IDE tells you that `allowed-tools: Read` doesn't cover the `Edit` your step 3 uses, that your trigger phrases will never fire, or that a hook file exists but is wired to nothing. And the config surface isn't even one folder you could open.

**The honest version:** a power user who knows the docs cold can do all of this manually. The app doesn't make anything *possible* — it makes it **visible, repeatable, and safe for people who don't have the docs memorized**. It's not a competitor to Claude Code; it drives `claude` underneath — the garage with diagnostics, not a second engine.

## Who it's for

**Non-technical users** describe what they want in plain English — *"a skill that summarizes my uncommitted changes"* — and get a production-quality skill generated, quality-checked, and installed. Guided forms replace raw JSON everywhere: adding MCP servers, wiring hooks, editing settings. Every file, tab, and concept has a built-in explanation, and **🤖 Explain with AI** turns any artifact into plain English.

**Technical users** get full CRUD over every artifact type, a deterministic **tool-grant linter** with one-click repair, **one-shot runs** that stream `stream-json` output to JSONL files, a bounded **self-evaluation loop** for generated artifacts, every AI system prompt exposed and customizable, cross-platform copy-paste run commands (bash / PowerShell / portable), and a **prompt-health dashboard** that surfaces where the generation pipeline is failing — measured, not guessed.

## What it does

### See everything
- **Skills, agents, commands** — cards with descriptions, model pins, tool-grant badges, and a file explorer for every nested skill file.
- **Hooks** — hook files *and* their lifecycle wiring, including whether a hook is actually wired (`● PreToolUse`) or dead weight (`○ not wired`), plus hooks hiding inside skills and plugins.
- **Plugins & MCP servers** — merged from every location Claude Code reads: `installed_plugins.json`, `settings.json` (`enabledPlugins` + `mcpServers`), and `~/.claude.json` (user and project scope).
- **Settings, CLAUDE.md, keybindings** — direct editors with validation and per-tab explainers.

### Build with AI
- **Generate skills, agents, hooks (Node/Python/Bash), and commands** from a plain-language description. Curated system prompts encode Anthropic's current frontmatter reference — `allowed-tools`, `when_to_use`, `context: fork`, `disable-model-invocation`, the full agent field set — with an internal planning phase and strict output contracts.
- **Choose your model** per generation (Opus default for quality; Sonnet/Haiku for speed).
- **Optional self-eval**: an evaluator pass scores the result against an inversion checklist with the deterministic lint as ground truth. Hard-capped at 2 evaluations + 1 auto-revision — it can never loop.
- **Workflows**: plan a multi-component workflow from a goal, generate each component through the full per-type pipeline, auto-wire hooks to their events, or **Compose from Installed** — the AI checks what your existing pieces can already do, verified against disk so it never claims something is installed when it isn't.
- **Custom events**: describe a condition ("when Claude pushes to git") and get a derived event — the right built-in hook event, a fail-open detector script, and automatic wiring.

### Stay correct — enforced, not suggested
- **Tool-grant lint**: every skill/agent/command is checked — *every tool the body uses must be granted, every grant must be used*. Violations show as a **⚠ grants incomplete** badge naming the exact gap.
- **🔧 one-click repair**: missing grants are written into the frontmatter. Bash is granted only as exact-prefix rules derived from the body's own commands (`Bash(pytest *)`) — never a blanket grant, never an unrecognized command.
- **Auto-grant at generation time**: even if you never mention permissions, grants are derived from the generated content.
- **Recovery pipeline**: chat-escaped markdown, wrapper code fences, and leading prose are detected and repaired before anything is saved — and every recovery firing is logged.

### Run and verify
- **▶ Run** any skill, agent, command, or workflow one-shot: choose working directory, output JSONL path, model pin, and an optional expected-output contract. Live tail, stop button, 15-minute timeout.
- Prefer a terminal? The modal generates the exact command in your dialect — **bash/zsh**, **Windows PowerShell**, or **Portable** (valid in all three) — in two flavors: **🛡 Ask each step** (default — an interactive session that asks before every edit and command, for playing safe) or **⚡ Skip & log** (unattended, streams JSONL). Destructive commands are blocked in both.
- **OpenRouter provider** for text-only dry runs when Claude Code isn't installed.

### Improve over time
- **Prompt health** (Settings → Prompts): every AI call logs its defect signals locally — fence-strips, escape-fixes, JSON failures, lint gaps, eval scores. A rising rate points at the exact prompt with a hole. Zero cost, zero cloud, zero AI calls.
- **Customizable prompts**: all 14 system prompts are editable; your version is used everywhere, template tokens are validated, and the UI warns when a built-in default has improved since you customized.
- **Doc-synced catalogs**: the Updates tab diffs Anthropic's documentation against the app's hook-event and settings-key catalogs and teaches the app new ones in one click.

## Quick start

Requirements: **Node.js ≥ 18**. Optional: [Claude Code CLI](https://code.claude.com/docs) for runs and CLI-based generation, or an [OpenRouter](https://openrouter.ai) API key as the alternative AI provider.

```bash
git clone git@github.com:neeraj1892/claude-manager.git
cd claude-manager
npm install
npm start
```

Open **http://localhost:3000**. The app manages `~/.claude` by default:

```bash
node server.js /path/to/.claude       # different folder
PORT=3001 npm start                   # different port
```

## Using it properly

1. **Start at Overview** — it maps how skills, agents, hooks, commands, plugins, and workflows fit together, and suggests good first moves.
2. **Generate, don't hand-write.** The generation prompts encode more of Anthropic's current best practices than most of us remember. Use the context fields (tech stack, domain, MCP references) — they inform the design without being hardcoded into the artifact.
3. **Trust the badges.** `🔓 pre-approved` means the artifact runs without permission prompts; **⚠ grants incomplete** means it will stall at runtime — click 🔧.
4. **Run before you rely.** One-shot runs with an expected-output contract are the cheapest way to find out whether a skill actually does what its description claims.
5. **Opt into eval for important artifacts.** One checkbox, max 3 model calls, and you get a scored review with concrete fixes.
6. **Check Prompt health monthly.** If a defect rate climbs after you customize a prompt, your customization regressed something.
7. **First one-shot run?** `--dangerously-skip-permissions` must be accepted once in an interactive `claude` session before non-interactive runs can use it.

## Tech stack & architecture

| Layer | Choice | Why |
|---|---|---|
| Server | Node.js + Express 4 (the only dependency) | Local, single-user tool — no framework overhead |
| Frontend | Vanilla JS + Monaco editor, single-page | Zero build step; `Cache-Control: no-store` means updates apply on refresh |
| Design | Apple HIG system colors + Sanzo Wada-inspired identity palette | Color encodes *state*, not decoration |
| AI providers | Claude Code CLI (`claude -p`) and OpenRouter | Subscription-based or API-based, user's choice |
| Tests | Node's built-in `node --test`, 250 tests | Each file boots an isolated server: temp `.claude`, temp `HOME`, fixture marketplace/OpenRouter endpoints, and a fake `claude` CLI shim — no network, no real install needed |

Notable engineering decisions:

- **Generation is token-dieted**: `claude -p` calls strip MCP schemas, the skills listing, and session persistence (`--strict-mcp-config --disable-slash-commands --no-session`) with automatic fallback on older CLI versions.
- **Correctness is enforced in code, not prompts**: the tool-grant lint, auto-grant, fence/escape recovery, and the eval loop's hard cap are deterministic server-side logic. Prompts teach; the pipeline verifies.
- **Secrets can't be committed**: your OpenRouter key lives outside the repo in `~/.claude-manager.secrets.json` (chmod 600); keys found in old configs are migrated out automatically and the server warns if a secrets file is ever git-tracked.

## Security

- Binds to localhost; designed for local, single-user use.
- File APIs are path-traversal-guarded and scoped to the managed `.claude` folder.
- Marketplace installs execute only `claude mcp add` / `claude plugin …` commands — anything else is rejected.

### ⚠️ The big caveat: one-shot runs bypass permissions

One-shot **▶ Run** uses `claude --dangerously-skip-permissions`. Be clear-eyed about what that means: Claude gets full tool access with **no confirmation gates** — it can edit and delete files, run shell commands, and reach the network as your user. Nothing technically confines it to the working directory you chose, and a misinterpreted prompt **can produce changes you didn't ask for**. This is inherent to unattended agent runs, not something this app can fully solve.

**What protects you today:**

- **Enforced deny rules on every run** — the app passes `--disallowedTools` blocking `rm -rf` (all spellings), `sudo rm`, `git push --force`, and `git reset --hard`. Deny rules are evaluated by Claude Code *regardless of permission mode*, so these hold even under `--dangerously-skip-permissions` — mechanical, not advisory. The same flags are baked into the copy-paste terminal commands.
- **Scope guardrails in every run prompt** — work only within the task and working directory, no unrequested files, no package installs or commits unless asked, and stop-and-report when a task seems to need something destructive. (Steering — the deny rules above are the hard layer.)
- **Full audit trail** — the JSONL output logs *every* tool call, file touched, and command run. After any run, the log is the complete record of what Claude actually did.
- **`deny` rules survive bypass mode.** Claude Code evaluates `permissions.deny` regardless of mode — rules like `Read(.env)`, `Read(**/secrets/**)`, or `Edit(//path/to/prod/**)` in your `settings.json` hold even under `--dangerously-skip-permissions`. Set them once (Settings → ✨ Add with AI can write them for you).
- **Built-in circuit breakers** — Claude Code still prompts on catastrophic removals (`rm -rf /`, `rm -rf ~`) even in bypass mode.
- **Stop button + 15-minute timeout** on every run.
- Generated skills carry explicit scope constraints ("do not commit, do not add unrequested features") — steering, not a guarantee.

**What you should do:**

1. **Run inside a clean git checkout.** `git status` before, `git diff` after — you see every change and `git checkout .` reverts anything unwanted. This is the single most effective habit.
2. For artifacts you don't fully trust, use a **disposable copy of the project**.
3. Never point a run at a directory containing live credentials or production configs.

**"Why not just scope Claude to one folder?"** Two different answers:

- *The app's own AI calls* (generate, improve, eval, explain) need no scoping — they run with **zero tools**. Claude can't read or write anything during generation; it only returns text, and the app saves it safely.
- *One-shot runs* can't be locked to `.claude` — their whole purpose is doing work in your project folder. There's no reliable way to hard-fence a run to a single folder today, which is exactly why the git-checkout habit above is the recommendation: you can't fully prevent an unwanted change, but you can always see it and revert it.

**What we don't do yet (honestly):** no sandbox, no automatic post-run diff summary, no rollback button. A post-run `git diff --stat` panel is the most likely next safety feature.

## Testing

```bash
npm test
```

250 tests covering every endpoint and scenario, including regression tests for every bug found in production use. See [`tests/README.md`](tests/README.md) for the bug-fix history.

## Project structure

```
server.js        # Express server — all API endpoints, AI prompts, lint/enforcement, runners
public/
  index.html     # single-page UI
  app.js         # UI logic
  styles.css     # design system (Apple HIG + Wada palette, dark/light)
tests/           # node --test suite (isolated server per file)
META-PROMPTS.md  # review snapshot of all 14 AI system prompts
```

## License

MIT — see [LICENSE](LICENSE).
