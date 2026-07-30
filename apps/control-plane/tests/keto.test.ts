import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetConfigForTest } from '../src/lib/server/config'
import {
  hasProductAdmission,
  hasProductAdmissionStrict,
  setTenantMembership,
} from '../src/lib/server/keto'
import type { TenantRolePolicy } from '../src/lib/server/product-catalog'

const originalEnvironment = { ...process.env }
const rolePolicy: TenantRolePolicy = {
  roles: new Map([
    ['member', { id: 'member', permissions: new Set(['access']) }],
    ['tenant_admin', { id: 'tenant_admin', permissions: new Set(['access', 'administer']) }],
  ]),
}

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
  it('removes every existing role before granting the desired role', async () => {
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
      tenantId: '01900000-0000-7000-8000-000000000001',
      product: 'freightclaims',
      role: 'member',
      rolePolicy,
      state: 'active',
    })

    expect(calls.map((call) => [call.method, call.body])).toEqual([
      ['DELETE', null],
      ['DELETE', null],
      [
        'PUT',
        {
          namespace: 'TenantRole',
          object: 'freightclaims:MDE5MDAwMDAtMDAwMC03MDAwLTgwMDAtMDAwMDAwMDAwMDAx:member',
          relation: 'assignees',
          subject_id: 'bb86046e-c922-44a3-a85f-ba21042c2897',
        },
      ],
    ])
    expect(calls.slice(0, 2).map((call) => call.url.searchParams.get('relation'))).toEqual([
      'assignees',
      'assignees',
    ])
  })

  it('removes every configured tenant role when access is revoked', async () => {
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
      tenantId: '01900000-0000-7000-8000-000000000001',
      product: 'freightclaims',
      role: 'member',
      rolePolicy,
      state: 'revoked',
    })

    expect(calls.map((url) => url.searchParams.get('relation'))).toEqual(['assignees', 'assignees'])
  })
})
