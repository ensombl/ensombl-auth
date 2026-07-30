import { afterEach, describe, expect, it, vi } from 'vitest'

const keto = vi.hoisted(() => ({
  setTenantMembership: vi.fn(),
}))

vi.mock('$lib/server/keto', () => keto)

import { resetConfigForTest } from '../src/lib/server/config'
import { PUT } from '../src/routes/internal/tenants/memberships/+server'

const originalEnvironment = { ...process.env }

function request(
  overrides: Record<string, unknown> = {},
  bearer = 'local-only-freightclaims-local-web-identity-management-secret',
): Request {
  return new Request('http://control-plane/internal/tenants/memberships', {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      client_id: 'freightclaims-local-web',
      identity_id: 'bb86046e-c922-44a3-a85f-ba21042c2897',
      tenant_id: '01900000-0000-7000-8000-000000000001',
      role: 'member',
      state: 'active',
      ...overrides,
    }),
  })
}

afterEach(() => {
  process.env = { ...originalEnvironment }
  resetConfigForTest()
  vi.clearAllMocks()
})

describe('product-scoped tenant membership management', () => {
  it('derives the product from the authenticated client', async () => {
    keto.setTenantMembership.mockResolvedValue(undefined)

    const response = await PUT({ request: request() } as Parameters<typeof PUT>[0])

    expect(response.status).toBe(204)
    expect(keto.setTenantMembership).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        identityId: 'bb86046e-c922-44a3-a85f-ba21042c2897',
        tenantId: '01900000-0000-7000-8000-000000000001',
        product: 'freightclaims:local',
        role: 'member',
        state: 'active',
      }),
    )
  })

  it('rejects another capability secret before writing Keto', async () => {
    const response = await PUT({
      request: request({}, 'local-only-freightclaims-local-web-authorization-decision-secret'),
    } as Parameters<typeof PUT>[0])

    expect(response.status).toBe(401)
    expect(keto.setTenantMembership).not.toHaveBeenCalled()
  })

  it('fails closed when Keto cannot apply the desired state', async () => {
    keto.setTenantMembership.mockRejectedValue(new Error('keto unavailable'))

    const response = await PUT({ request: request() } as Parameters<typeof PUT>[0])

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'identity_management_unavailable',
    })
  })

  it('rejects a role outside the product policy', async () => {
    const response = await PUT({
      request: request({ role: 'owner' }),
    } as Parameters<typeof PUT>[0])

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'invalid_role' })
    expect(keto.setTenantMembership).not.toHaveBeenCalled()
  })
})
