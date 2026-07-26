import { describe, expect, it, vi } from 'vitest'
import { loadSettingsMode } from '../src/lib/server/settings-mode'
import type { KratosFlow, KratosSession } from '../src/lib/server/types'

const flow: KratosFlow = {
  id: 'settings-flow',
  ui: {
    action: 'https://auth.ensombl.io/self-service/settings?flow=settings-flow',
    method: 'POST',
    nodes: [],
  },
}

function session(active = true): KratosSession {
  return {
    id: 'session-id',
    active,
    identity: {
      id: 'f2a369ac-160c-44b6-ac95-d7801b370b48',
      traits: {
        email: 'user@example.test',
      },
    },
  }
}

describe('settings mode', () => {
  it('does not trust a forced query flag when the reset gate is clear', async () => {
    const isResetRequired = vi.fn(async () => false)
    const result = await loadSettingsMode(
      new URL('https://auth.ensombl.io/ui/settings?flow=settings-flow&forced=1'),
      'ory_session=session-cookie',
      {
        loadFlow: vi.fn(async () => ({ flow })),
        getKratosSession: vi.fn(async () => session()),
        isResetRequired,
      },
    )

    expect(result.forced).toBe(false)
    expect(isResetRequired).toHaveBeenCalledExactlyOnceWith('f2a369ac-160c-44b6-ac95-d7801b370b48')
  })

  it('forces password-only settings from the session identity reset gate', async () => {
    const result = await loadSettingsMode(
      new URL('https://auth.ensombl.io/ui/settings?flow=settings-flow&forced=0'),
      'ory_session=session-cookie',
      {
        loadFlow: vi.fn(async () => ({ flow })),
        getKratosSession: vi.fn(async () => session()),
        isResetRequired: vi.fn(async () => true),
      },
    )

    expect(result.forced).toBe(true)
  })

  it('fails closed without an active Kratos session', async () => {
    const isResetRequired = vi.fn(async () => true)

    await expect(
      loadSettingsMode(
        new URL('https://auth.ensombl.io/ui/settings?flow=settings-flow'),
        'ory_session=inactive-session',
        {
          loadFlow: vi.fn(async () => ({ flow })),
          getKratosSession: vi.fn(async () => session(false)),
          isResetRequired,
        },
      ),
    ).rejects.toMatchObject({ status: 401 })
    expect(isResetRequired).not.toHaveBeenCalled()
  })
})
