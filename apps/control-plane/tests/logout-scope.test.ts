import { beforeEach, describe, expect, it, vi } from 'vitest'

const ory = vi.hoisted(() => ({
  acceptLogout: vi.fn(),
  getLogoutRequest: vi.fn(),
  rejectLogout: vi.fn(),
}))

vi.mock('$lib/server/ory', () => ory)

import { actions } from '../src/routes/ui/oauth2/logout/+page.server'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('application logout scope', () => {
  it('accepts only the Hydra application logout and retains the Kratos identity session', async () => {
    ory.acceptLogout.mockResolvedValue({
      redirect_to: 'https://freightclaims.ensombl.io/',
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
      location: 'https://freightclaims.ensombl.io/',
    })
    expect(ory.acceptLogout).toHaveBeenCalledExactlyOnceWith('logout-challenge')
    expect(ory.rejectLogout).not.toHaveBeenCalled()
  })
})
