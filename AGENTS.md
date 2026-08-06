# Agents Observe

Real-time observability dashboard for Claude Code agents. Captures every hook event and streams it to a live dashboard.

## Install as Plugin

```bash
claude plugin marketplace add simple10/agents-observe
claude plugin install agents-observe
```

Restart Claude Code. The plugin's hooks capture every event and arm the collector when it isn't
running — on a plugin install the first start also installs the server's dependencies and builds
the dashboard, a one-time cost — and the dashboard is at **http://localhost:4981**.

### Skills

| Command | Description |
|---------|-------------|
| `/observe view` | Open the current session in the dashboard |
| `/observe stats` | Open the current session's stats modal |
| `/observe` | Open the dashboard |
| `/observe status` | Server health and config |
| `/observe start` | Start the server |
| `/observe stop` | Stop the server |
| `/observe restart` | Restart the server |
| `/observe logs` | Show recent server logs |
| `/observe debug` | Diagnose server issues |

## Clone & Run

Requires [just](https://github.com/casey/just) and [Node.js](https://nodejs.org/).

```bash
git clone https://github.com/simple10/agents-observe.git
cd agents-observe
just install   # install dependencies
just start     # start the supervised collector
```

Dashboard: http://localhost:4981

For dev mode with hot reload: `just dev` (client at http://localhost:5174, API at http://localhost:4981).

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Server not running | Run `/observe start` or restart Claude Code |
| Port conflict | Set `AGENTS_OBSERVE_SERVER_PORT=<port>` in `.env` |
| Need diagnostics | Run `/observe debug` |
| Database issues | Run `just db-reset` |

## Development

**Before developing features or modifying code, read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).** It covers architecture, project structure, commands (`just dev`, `just test`, etc.), environment variables, worktree setup, code style, and testing.

Key points:
- Use `just dev` for hot-reload development
- **Run `just check` before every commit** — runs all tests + formatting
- Use `just` commands for all dev tasks (not `npm` directly) — see `just --list`
- Worktrees need a `.env` with unique ports and a unique data root (see DEVELOPMENT.md § Worktrees)
- All env vars are centralized in `hooks/scripts/lib/config.mjs` — never read `process.env` elsewhere
- TypeScript throughout, kebab-case file names
- Collector supervision (locks, heartbeat, process identity) has its own contract and invariants — read [docs/collector-supervision.md](docs/collector-supervision.md) before touching `hooks/scripts/supervision/` or `app/server/src/supervision/`. Those two are mirrored implementations of one on-disk contract; tests assert they agree, so change them together
- `hooks/scripts/hook.sh` is the **only** way any agent starts or reaches the collector — every event spools, then arms the supervisor if it isn't healthy. Don't add a second start path; `observe_cli.mjs start/stop/restart` drive the same arm
- The collector always runs as a host Node process. A plugin install is a source-only clone, so the first start bootstraps it (`observe_bootstrap_collector`): server deps, then the client build. Everything the plugin needs at runtime therefore has to be buildable from this tree with `npm` — see [docs/collector-supervision.md](docs/collector-supervision.md)
- Project resolution (`app/server/src/services/project-resolver.ts`) and session titling (`app/server/src/services/session-title.ts`, wired into `routes/events.ts`'s `UserPromptSubmit` handling and `routes/callbacks.ts`'s `getSessionInfo` callback) are two halves of the same "don't show meaningless auto-generated identities" contract — read both together before changing either

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages. The release script uses `git log` to generate CHANGELOG.md entries via Claude, and consistent prefixes help it categorize changes accurately.

**Format:** `<type>: <description>`

| Prefix | Use for |
|--------|---------|
| `feat:` | New features or capabilities |
| `fix:` | Bug fixes |
| `docs:` | Documentation changes |
| `style:` | CSS, formatting, visual changes (no logic change) |
| `refactor:` | Code restructuring (no behavior change) |
| `test:` | Adding or updating tests |
| `chore:` | Build scripts, tooling, dependencies, config |
| `release:` | Version bumps (used by `scripts/release.sh`) |

**Examples:**
```
feat: add X button to clear search query
fix: timeline dots animating at different speeds
style: add cursor-pointer to clickable sidebar elements
refactor: replace per-dot transitions with container animation
chore: update release script with changelog generation
docs: document fresh install test harness usage
```

Breaking changes: add `!` after the type (e.g., `feat!: rename config namespace`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
