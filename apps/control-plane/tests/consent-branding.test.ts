import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ory = vi.hoisted(() => ({
  acceptConsent: vi.fn(),
  getConsentRequest: vi.fn(),
  getKratosSession: vi.fn(),
  rejectConsent: vi.fn(),
}))

vi.mock('$lib/server/ory', () => ory)

import { resetConfigForTest } from '../src/lib/server/config'
import { load } from '../src/routes/ui/oauth2/consent/+page.server'

const originalEnvironment = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.PRODUCT_CATALOG_PATH = resolve(process.cwd(), '../../deploy/products/products.json')
  resetConfigForTest()
})

afterEach(() => {
  process.env = { ...originalEnvironment }
  resetConfigForTest()
})

describe('OAuth consent branding', () => {
  it.each([
    ['freightclaims-staging-web', 'https://auth.freightclaims.com'],
    ['freightcheck-staging-web', 'https://auth.freightcheck.io'],
  ])('moves the %s challenge before checking the host-scoped Kratos session', async (clientId, authOrigin) => {
    ory.getConsentRequest.mockResolvedValue({
      challenge: 'consent-challenge',
      client: {
        client_id: clientId,
        client_name: 'Product',
      },
      requested_scope: ['openid'],
      skip: true,
      subject: 'identity-id',
    })

    await expect(
      load({
        url: new URL(
          'https://auth.ensombl.io/ui/oauth2/consent?consent_challenge=consent-challenge',
        ),
        request: new Request('https://auth.ensombl.io/ui/oauth2/consent'),
      } as Parameters<typeof load>[0]),
    ).rejects.toMatchObject({
      status: 303,
      location: `${authOrigin}/ui/oauth2/consent?consent_challenge=consent-challenge`,
    })
    expect(ory.getKratosSession).not.toHaveBeenCalled()
  })
})
