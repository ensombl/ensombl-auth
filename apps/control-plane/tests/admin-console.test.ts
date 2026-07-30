import { describe, expect, it, vi } from 'vitest'
import { adminConsoleAccess } from '../src/lib/server/admin-console'
import type { KratosSession } from '../src/lib/server/types'

const products = [
  { id: 'freightclaims', displayName: 'FreightClaims' },
  { id: 'freightcheck', displayName: 'FreightCheck' },
]

function session(): KratosSession {
  return {
    id: 'session-id',
    active: true,
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
    hasProductAdministrationStrict: vi.fn(async (_identityId: string, product: string) => {
      return product === 'freightclaims'
    }),
    ...overrides,
  }
}

describe('admin console access', () => {
  it('requires login before reading product administration', async () => {
    await expect(
      adminConsoleAccess(
        null,
        products,
        dependencies({ getKratosSession: vi.fn(async () => null) }),
      ),
    ).resolves.toEqual({ state: 'login_required' })
  })

  it('requires a migrated password reset before reading products', async () => {
    await expect(
      adminConsoleAccess(
        'ory_session=cookie',
        products,
        dependencies({ isResetRequired: vi.fn(async () => true) }),
      ),
    ).resolves.toEqual({ state: 'password_reset_required' })
  })

  it('returns only products the identity administers', async () => {
    await expect(
      adminConsoleAccess('ory_session=cookie', products, dependencies()),
    ).resolves.toEqual({
      state: 'authorized',
      products: [{ id: 'freightclaims', displayName: 'FreightClaims' }],
    })
  })

  it('denies identities without product administration', async () => {
    await expect(
      adminConsoleAccess(
        'ory_session=cookie',
        products,
        dependencies({ hasProductAdministrationStrict: vi.fn(async () => false) }),
      ),
    ).resolves.toEqual({ state: 'product_administrator_required' })
  })
})
