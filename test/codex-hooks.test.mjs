import { describe, expect, it } from 'vitest'
import {
  buildManagedCommand,
  enableCodexHooksFeature,
  installHooksConfig,
  uninstallHooksConfig,
} from '../scripts/codex-hooks.mjs'

describe('global Codex hook installer', () => {
  const hookScript = '/opt/agents observe/hooks/scripts/hook.sh'

  it('adds all managed events while preserving unrelated hooks', () => {
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo existing' }],
          },
        ],
      },
    }

    const installed = installHooksConfig(existing, hookScript)

    expect(installed.hooks.PreToolUse).toHaveLength(2)
    expect(installed.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0])
    expect(installed.hooks.SessionStart[0].hooks[0].command).toContain(
      'AGENTS_OBSERVE_INTEGRATION=codex-global',
    )
    expect(installed.hooks.Stop[0].hooks[0].command).toContain(
      'AGENTS_OBSERVE_NOTIFICATION_ON_EVENTS=Stop',
    )
  })

  it('is idempotent and replaces stale managed entries', () => {
    const once = installHooksConfig({}, '/old/path/hook.sh')
    const twice = installHooksConfig(once, '/new/path/hook.sh')

    expect(twice.hooks.PreToolUse).toHaveLength(1)
    expect(twice.hooks.PreToolUse[0].hooks[0].command).toContain('/new/path/hook.sh')
    expect(twice.hooks.PreToolUse[0].hooks[0].command).not.toContain('/old/path/hook.sh')
  })

  it('removes only Agents Observe entries', () => {
    const installed = installHooksConfig(
      {
        hooks: {
          PostToolUse: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }],
        },
      },
      hookScript,
    )

    const removed = uninstallHooksConfig(installed)

    expect(removed.hooks.PostToolUse).toEqual([
      { hooks: [{ type: 'command', command: 'echo keep-me' }] },
    ])
    expect(removed.hooks.SessionStart).toBeUndefined()
  })

  it('enables codex_hooks without replacing other feature settings', () => {
    expect(enableCodexHooksFeature('model = "gpt"\n')).toBe(
      'model = "gpt"\n\n[features]\ncodex_hooks = true\n',
    )
    expect(enableCodexHooksFeature('[features]\nother = true\ncodex_hooks = false\n')).toBe(
      '[features]\nother = true\ncodex_hooks = true\n',
    )
    expect(enableCodexHooksFeature('[features]\nother = true\n\n[tools]\nweb = true\n')).toBe(
      '[features]\nother = true\n\ncodex_hooks = true\n[tools]\nweb = true\n',
    )
  })

  it('shell-quotes hook paths', () => {
    expect(buildManagedCommand(hookScript, 'PreToolUse')).toContain(
      "bash '/opt/agents observe/hooks/scripts/hook.sh'",
    )
  })
})
