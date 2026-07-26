import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetConfigForTest } from '../src/lib/server/config'
import { hasProductAdmission, hasProductAdmissionStrict } from '../src/lib/server/keto'

const originalEnvironment = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnvironment }
  resetConfigForTest()
  vi.restoreAllMocks()
})

describe('Keto admission reads', () => {
  it('throws on an unavailable strict membership read used by invitation issuance', async () => {
    process.env.KETO_READ_URL = 'http://keto.test'
    resetConfigForTest()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))

    await expect(
      hasProductAdmissionStrict('bb86046e-c922-44a3-a85f-ba21042c2897', 'freightclaims'),
    ).rejects.toThrow('Unable to read product admission')
  })

  it('keeps ordinary OAuth admission fail-closed on the same outage', async () => {
    process.env.KETO_READ_URL = 'http://keto.test'
    resetConfigForTest()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))

    await expect(
      hasProductAdmission('bb86046e-c922-44a3-a85f-ba21042c2897', 'freightclaims'),
    ).resolves.toBe(false)
  })
})
