import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const keto = vi.hoisted(() => ({
  hasTenantPermissionStrict: vi.fn(),
}))

vi.mock('$lib/server/keto', () => keto)

import { resetConfigForTest } from '../src/lib/server/config'
import { POST } from '../src/routes/internal/authorization/check/+server'

const originalEnvironment = { ...process.env }
const productCatalogPath = resolve(process.cwd(), '../../deploy/products/products.json')
const stageSecret = 'stage-authorization-decision-secret-that-is-long-enough'

function request(overrides: Record<string, unknown> = {}, bearer = stageSecret): Request {
  return new Request('http://control-plane/internal/authorization/check', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      client_id: 'freightclaims-stage-web',
      subject_id: 'bb86046e-c922-44a3-a85f-ba21042c2897',
      organization_id: '01900000-0000-7000-8000-000000000001',
      permission: 'access',
      ...overrides,
    }),
  })
}

afterEach(() => {
  process.env = { ...originalEnvironment }
  resetConfigForTest()
  vi.clearAllMocks()
})

describe('product-scoped authorization decisions', () => {
  it('binds the client credential to its configured product tenant', async () => {
    process.env.PRODUCT_CATALOG_PATH = productCatalogPath
    process.env.FREIGHTCLAIMS_STAGE_AUTHORIZATION_DECISION_SECRET = stageSecret
    process.env.FREIGHTCLAIMS_PROD_AUTHORIZATION_DECISION_SECRET =
      'prod-authorization-decision-secret-that-is-long-enough'
    resetConfigForTest()
    keto.hasTenantPermissionStrict.mockResolvedValue(true)

    const response = await POST({ request: request() } as Parameters<typeof POST>[0])

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ allowed: true })
    expect(keto.hasTenantPermissionStrict).toHaveBeenCalledExactlyOnceWith(
      'bb86046e-c922-44a3-a85f-ba21042c2897',
      'freightclaims',
      '01900000-0000-7000-8000-000000000001',
      'access',
    )
  })

  it('rejects a credential for another client before consulting Keto', async () => {
    process.env.PRODUCT_CATALOG_PATH = productCatalogPath
    process.env.FREIGHTCLAIMS_STAGE_AUTHORIZATION_DECISION_SECRET = stageSecret
    process.env.FREIGHTCLAIMS_PROD_AUTHORIZATION_DECISION_SECRET =
      'prod-authorization-decision-secret-that-is-long-enough'
    resetConfigForTest()

    const response = await POST({
      request: request({ client_id: 'freightclaims-web' }),
    } as Parameters<typeof POST>[0])

    expect(response.status).toBe(401)
    expect(keto.hasTenantPermissionStrict).not.toHaveBeenCalled()
  })

  it('fails closed when the private authorization plane is unavailable', async () => {
    process.env.PRODUCT_CATALOG_PATH = productCatalogPath
    process.env.FREIGHTCLAIMS_STAGE_AUTHORIZATION_DECISION_SECRET = stageSecret
    process.env.FREIGHTCLAIMS_PROD_AUTHORIZATION_DECISION_SECRET =
      'prod-authorization-decision-secret-that-is-long-enough'
    resetConfigForTest()
    keto.hasTenantPermissionStrict.mockRejectedValue(new Error('keto unavailable'))

    const response = await POST({ request: request() } as Parameters<typeof POST>[0])

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'authorization_unavailable' })
  })
})
