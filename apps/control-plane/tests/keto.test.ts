import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetConfigForTest } from '../src/lib/server/config'
import {
  hasProductAdmission,
  hasProductAdmissionStrict,
  setTenantMembership,
} from '../src/lib/server/keto'

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

describe('Keto tenant membership desired state', () => {
  it('removes administrator access before granting a demoted member relation', async () => {
    process.env.KETO_WRITE_URL = 'http://keto.test'
    resetConfigForTest()
    const calls: Array<{ method: string; url: URL; body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? 'GET',
          url: new URL(String(input)),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        })
        return new Response(null, { status: 204 })
      }),
    )

    await setTenantMembership({
      identityId: 'bb86046e-c922-44a3-a85f-ba21042c2897',
      organizationId: '01900000-0000-7000-8000-000000000001',
      product: 'freightclaims',
      relation: 'members',
      state: 'active',
    })

    expect(calls.map((call) => [call.method, call.body])).toEqual([
      [
        'PUT',
        {
          namespace: 'Tenant',
          object: 'freightclaims:01900000-0000-7000-8000-000000000001',
          relation: 'product',
          subject_set: { namespace: 'Product', object: 'freightclaims', relation: '' },
        },
      ],
      [
        'PUT',
        {
          namespace: 'Tenant',
          object: 'freightclaims:01900000-0000-7000-8000-000000000001',
          relation: 'organization',
          subject_set: {
            namespace: 'Organization',
            object: '01900000-0000-7000-8000-000000000001',
            relation: '',
          },
        },
      ],
      ['DELETE', null],
      [
        'PUT',
        {
          namespace: 'Organization',
          object: '01900000-0000-7000-8000-000000000001',
          relation: 'members',
          subject_id: 'bb86046e-c922-44a3-a85f-ba21042c2897',
        },
      ],
    ])
    expect(calls[2]?.url.searchParams.get('relation')).toBe('administrators')
  })

  it('removes both organization relations when access is revoked', async () => {
    process.env.KETO_WRITE_URL = 'http://keto.test'
    resetConfigForTest()
    const calls: URL[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        calls.push(new URL(String(input)))
        return new Response(null, { status: 404 })
      }),
    )

    await setTenantMembership({
      identityId: 'bb86046e-c922-44a3-a85f-ba21042c2897',
      organizationId: '01900000-0000-7000-8000-000000000001',
      product: 'freightclaims',
      relation: 'members',
      state: 'revoked',
    })

    expect(calls.map((url) => url.searchParams.get('relation'))).toEqual([
      'administrators',
      'members',
    ])
  })
})
