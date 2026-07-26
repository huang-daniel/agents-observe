# Global Codex hooks

Agents Observe can register its Codex hooks once at the user level so Codex sessions launched from any repository—including Firstmate-managed projects—use the same observer integration.

## Install

From the Agents Observe checkout:

```bash
node scripts/codex-hooks.mjs install
```

The installer:

- writes managed entries to `${CODEX_HOME:-$HOME/.codex}/hooks.json`;
- enables `codex_hooks = true` in `${CODEX_HOME:-$HOME/.codex}/config.toml`;
- points every managed hook at this checkout's absolute `hooks/scripts/hook.sh` path;
- preserves unrelated Codex hooks and feature settings;
- replaces older Agents Observe managed entries instead of duplicating them; and
- creates `.agents-observe.bak` backups before replacing existing files.

Restart Codex after installation and approve the commands when Codex requests hook trust.

## Status

```bash
node scripts/codex-hooks.mjs status
```

The command succeeds only when all managed events are installed:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`

## Uninstall

```bash
node scripts/codex-hooks.mjs uninstall
```

Uninstall removes only entries marked as the Agents Observe global integration. It intentionally leaves the Codex hook feature enabled because other integrations may depend on it.

## Custom locations

Use `CODEX_HOME` or the explicit CLI options when Codex or Agents Observe lives somewhere non-standard:

```bash
CODEX_HOME=/custom/codex-home node scripts/codex-hooks.mjs install

node scripts/codex-hooks.mjs install \
  --codex-home /custom/codex-home \
  --hook-script /opt/agents-observe/hooks/scripts/hook.sh
```

## Architecture

The global registration is only the event-source adapter:

```text
Codex in any project
        │
        ▼
~/.codex/hooks.json
        │
        ▼
absolute Agents Observe hook.sh
        │
        ▼
shared Agents Observe delivery and supervision path
```

It does not make Firstmate responsible for Agents Observe. Firstmate may launch Codex in any working directory; Codex loads the user-level hooks and forwards events to the same Agents Observe installation.

As the arm/watcher work is wired into `hook.sh`, globally installed Codex hooks will automatically converge on that same shared spool, arm, watcher, server, and data root without requiring per-project hook files.
