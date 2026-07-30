import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ory = vi.hoisted(() => ({
  acceptLogout: vi.fn(),
  getLogoutRequest: vi.fn(),
  rejectLogout: vi.fn(),
}))

vi.mock('$lib/server/ory', () => ory)

import { resetConfigForTest } from '../src/lib/server/config'
import { actions, load } from '../src/routes/ui/oauth2/logout/+page.server'

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

describe('application logout scope', () => {
  it.each([
    ['freightclaims-staging-web', 'https://auth.freightclaims.com'],
    ['freightcheck-staging-web', 'https://auth.freightcheck.io'],
  ])('moves a %s logout challenge to the branded auth hostname', async (clientId, authOrigin) => {
    ory.getLogoutRequest.mockResolvedValue({
      challenge: 'logout-challenge',
      client: {
        client_id: clientId,
        client_name: 'Product',
      },
      rp_initiated: true,
    })

    await expect(
      load({
        url: new URL('https://auth.ensombl.io/ui/oauth2/logout?logout_challenge=logout-challenge'),
      } as Parameters<typeof load>[0]),
    ).rejects.toMatchObject({
      status: 303,
      location: `${authOrigin}/ui/oauth2/logout?logout_challenge=logout-challenge`,
    })
  })

  it('accepts only the Hydra application logout and retains the Kratos identity session', async () => {
    ory.acceptLogout.mockResolvedValue({
      redirect_to: 'https://app.freightclaims.ensombl.io/',
    })
    const request = new Request('https://auth.ensombl.io/ui/oauth2/logout?/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ challenge: 'logout-challenge' }),
    })
    const confirm = actions.confirm
    if (!confirm) throw new Error('Logout confirm action is missing')

    await expect(confirm({ request } as Parameters<typeof confirm>[0])).rejects.toMatchObject({
      status: 303,
      location: 'https://app.freightclaims.ensombl.io/',
    })
    expect(ory.acceptLogout).toHaveBeenCalledExactlyOnceWith('logout-challenge')
    expect(ory.rejectLogout).not.toHaveBeenCalled()
  })
})
