import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetConfigForTest } from '../src/lib/server/config'
import { POST } from '../src/routes/internal/oauth2/introspect/+server'

const originalEnvironment = { ...process.env }
const productCatalogPath = resolve(process.cwd(), '../../deploy/products/products.json')
const stagingSecret = 'stage-authorization-decision-secret-that-is-long-enough'

function request(clientId = 'freightclaims-staging-web', bearer = stagingSecret): Request {
  return new Request('https://auth.ensombl.io/internal/oauth2/introspect', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      token: 'opaque-machine-access-token',
    }),
  })
}

function configure(): void {
  process.env.PRODUCT_CATALOG_PATH = productCatalogPath
  process.env.FREIGHTCLAIMS_STAGING_AUTHORIZATION_DECISION_SECRET = stagingSecret
  process.env.FREIGHTCLAIMS_PRODUCTION_AUTHORIZATION_DECISION_SECRET =
    'prod-authorization-decision-secret-that-is-long-enough'
  resetConfigForTest()
}

afterEach(() => {
  process.env = { ...originalEnvironment }
  resetConfigForTest()
  vi.unstubAllGlobals()
})

describe('product-scoped OAuth introspection', () => {
  it('authenticates the product client before proxying only the token to Hydra admin', async () => {
    configure()
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        active: true,
        client_id: 'partner-client',
        scope: 'freightclaims:partner',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST({ request: request() } as Parameters<typeof POST>[0])

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      active: true,
      client_id: 'partner-client',
    })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toBe('http://localhost:24445/admin/oauth2/introspect')
    expect(init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    })
    expect(String(init?.body)).toBe('token=opaque-machine-access-token')
  })

  it('does not reach Hydra for a mismatched environment credential', async () => {
    configure()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST({
      request: request('freightclaims-production-web'),
    } as Parameters<typeof POST>[0])

    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects form-encoded product requests before reaching Hydra', async () => {
    configure()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST({
      request: new Request('https://auth.ensombl.io/internal/oauth2/introspect', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${stagingSecret}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: 'freightclaims-staging-web',
          token: 'opaque-machine-access-token',
        }),
      }),
    } as Parameters<typeof POST>[0])

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
