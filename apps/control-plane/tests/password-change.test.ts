import { describe, expect, it, vi } from 'vitest'
import { completePasswordChange } from '../src/lib/server/password-change'

const hook = {
  eventId: 'password_changed:flow-id:identity-id',
  identityId: 'bb86046e-c922-44a3-a85f-ba21042c2897',
  flowId: 'settings-flow-id',
  sessionId: 'session-id',
}

describe('password-change completion', () => {
  it('revokes every identity session before clearing the reset gate', async () => {
    const order: string[] = []
    const dependencies = {
      isResetRequired: vi.fn(async () => true),
      revokeIdentitySessions: vi.fn(async () => {
        order.push('revoke')
      }),
      clearResetGateFromHook: vi.fn(async () => {
        order.push('clear')
      }),
    }

    await completePasswordChange(hook, dependencies)

    expect(order).toEqual(['revoke', 'clear'])
    expect(dependencies.clearResetGateFromHook).toHaveBeenCalledExactlyOnceWith(hook)
  })

  it('never clears the reset gate when Kratos session revocation fails', async () => {
    const clearResetGateFromHook = vi.fn(async () => {})

    await expect(
      completePasswordChange(hook, {
        isResetRequired: vi.fn(async () => true),
        revokeIdentitySessions: vi.fn(async () => {
          throw new Error('Kratos unavailable')
        }),
        clearResetGateFromHook,
      }),
    ).rejects.toThrow('Kratos unavailable')
    expect(clearResetGateFromHook).not.toHaveBeenCalled()
  })

  it('does not revoke sessions created after a processed hook is replayed', async () => {
    const isResetRequired = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const revokeIdentitySessions = vi.fn(async () => {})
    const clearResetGateFromHook = vi.fn(async () => {})
    const dependencies = {
      isResetRequired,
      revokeIdentitySessions,
      clearResetGateFromHook,
    }

    await completePasswordChange(hook, dependencies)
    await completePasswordChange(hook, dependencies)

    expect(revokeIdentitySessions).toHaveBeenCalledTimes(1)
    expect(clearResetGateFromHook).toHaveBeenCalledTimes(1)
  })
})
