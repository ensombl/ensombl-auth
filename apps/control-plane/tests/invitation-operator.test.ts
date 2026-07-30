import { describe, expect, it, vi } from 'vitest'
import {
  authorizeInvitationOperator,
  invitationFormOriginAllowed,
  invitationOperatorAccess,
} from '../src/lib/server/invitation-operator'
import type { KratosSession } from '../src/lib/server/types'

function session(aal = 'aal2'): KratosSession {
  return {
    id: 'session-id',
    active: true,
    authenticator_assurance_level: aal,
    identity: {
      id: 'bb86046e-c922-44a3-a85f-ba21042c2897',
      traits: { email: 'operator@example.test' },
    },
  }
}

function dependencies(overrides = {}) {
  return {
    getKratosSession: vi.fn(async () => session()),
    isResetRequired: vi.fn(async () => false),
    hasProductAdministrationStrict: vi.fn(async () => true),
    ...overrides,
  }
}

describe('human invitation authorization', () => {
  it('accepts only the configured auth origin for form submissions', () => {
    expect(invitationFormOriginAllowed('https://auth.ensombl.io', 'https://auth.ensombl.io')).toBe(
      true,
    )
    expect(invitationFormOriginAllowed('https://attacker.example', 'https://auth.ensombl.io')).toBe(
      false,
    )
    expect(invitationFormOriginAllowed(null, 'https://auth.ensombl.io')).toBe(false)
  })

  it('derives the audit actor from an active AAL2 administrator session', async () => {
    await expect(
      authorizeInvitationOperator('ory_session=cookie', 'freightclaims', dependencies()),
    ).resolves.toBe('bb86046e-c922-44a3-a85f-ba21042c2897')
  })

  it('classifies browser access so the admin route can continue authentication', async () => {
    await expect(
      invitationOperatorAccess(
        null,
        'freightclaims',
        dependencies({ getKratosSession: vi.fn(async () => null) }),
      ),
    ).resolves.toEqual({ state: 'login_required' })
    await expect(
      invitationOperatorAccess(
        'ory_session=cookie',
        'freightclaims',
        dependencies({ isResetRequired: vi.fn(async () => true) }),
      ),
    ).resolves.toEqual({ state: 'password_reset_required' })
    await expect(
      invitationOperatorAccess(
        'ory_session=cookie',
        'freightclaims',
        dependencies({ hasProductAdministrationStrict: vi.fn(async () => false) }),
      ),
    ).resolves.toEqual({ state: 'product_administrator_required' })
    await expect(
      invitationOperatorAccess(
        'ory_session=cookie',
        'freightclaims',
        dependencies({ getKratosSession: vi.fn(async () => session('aal1')) }),
      ),
    ).resolves.toEqual({ state: 'aal2_required' })
  })

  it('denies AAL1, reset-gated, and non-administrator operators', async () => {
    await expect(
      authorizeInvitationOperator(
        'ory_session=cookie',
        'freightclaims',
        dependencies({ getKratosSession: vi.fn(async () => session('aal1')) }),
      ),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      authorizeInvitationOperator(
        'ory_session=cookie',
        'freightclaims',
        dependencies({ isResetRequired: vi.fn(async () => true) }),
      ),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      authorizeInvitationOperator(
        'ory_session=cookie',
        'freightclaims',
        dependencies({ hasProductAdministrationStrict: vi.fn(async () => false) }),
      ),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('fails closed when the strict Keto administration read is unavailable', async () => {
    await expect(
      authorizeInvitationOperator(
        'ory_session=cookie',
        'freightclaims',
        dependencies({
          hasProductAdministrationStrict: vi.fn(async () => {
            throw new Error('Keto unavailable')
          }),
        }),
      ),
    ).rejects.toThrow('Keto unavailable')
  })
})
