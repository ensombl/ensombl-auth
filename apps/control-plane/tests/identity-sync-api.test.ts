import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const identitySync = vi.hoisted(() => ({
  synchronizeIdentityBatch: vi.fn(),
}))

vi.mock('$lib/server/identity-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/server/identity-sync')>()),
  synchronizeIdentityBatch: identitySync.synchronizeIdentityBatch,
}))

import { resetConfigForTest } from '../src/lib/server/config'
import { PUT } from '../src/routes/internal/migration/identities/+server'

const originalEnvironment = { ...process.env }
const productCatalogPath = resolve(process.cwd(), '../../deploy/products/products.json')
const stagingSecret = 'staging-identity-migration-secret-that-is-long-enough'
const passwordHash =
  '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function request(overrides: Record<string, unknown> = {}, bearer = stagingSecret): Request {
  return new Request('http://control-plane/internal/migration/identities', {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      client_id: 'freightclaims-staging-web',
      source_snapshot: '20260729T230000Z-staging-shadow-test',
      identities: [
        {
          source_user_id: '42',
          email: 'user@example.com',
          password_hash: passwordHash,
          state: 'active',
          memberships: [
            {
              organization_id: '01900000-0000-7000-8000-000000000001',
              relation: 'members',
            },
          ],
        },
      ],
      ...overrides,
    }),
  })
}

function configure(): void {
  process.env.PRODUCT_CATALOG_PATH = productCatalogPath
  process.env.FREIGHTCLAIMS_STAGING_IDENTITY_MIGRATION_SECRET = stagingSecret
  process.env.FREIGHTCLAIMS_PRODUCTION_IDENTITY_MIGRATION_SECRET =
    'production-identity-migration-secret-that-is-long-enough'
  resetConfigForTest()
}

afterEach(() => {
  process.env = { ...originalEnvironment }
  resetConfigForTest()
  vi.clearAllMocks()
})

describe('deployment-scoped identity synchronization API', () => {
  it('derives source, compatible source, and admission from the authenticated client', async () => {
    configure()
    identitySync.synchronizeIdentityBatch.mockResolvedValue({
      request_sha256: 'a'.repeat(64),
      source: 'freightclaims-fc-staging',
      source_snapshot: '20260729T230000Z-staging-shadow-test',
      synchronized: 1,
      created: 1,
      linked: 0,
      revoked: 0,
      identities: [],
    })

    const response = await PUT({ request: request() } as Parameters<typeof PUT>[0])

    expect(response.status).toBe(200)
    expect(identitySync.synchronizeIdentityBatch).toHaveBeenCalledOnce()
    expect(identitySync.synchronizeIdentityBatch.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'freightclaims-staging-web',
      source: 'freightclaims-fc-staging',
      compatibleSources: ['freightclaims-fc-production'],
      admissionScope: 'freightclaims:staging',
      sourceSnapshot: '20260729T230000Z-staging-shadow-test',
      identities: [
        {
          sourceUserId: '42',
          email: 'user@example.com',
          passwordHash,
          state: 'active',
          memberships: [
            {
              organizationId: '01900000-0000-7000-8000-000000000001',
              relation: 'members',
            },
          ],
        },
      ],
    })
  })

  it('rejects a production capability before synchronizing a staging identity', async () => {
    configure()

    const response = await PUT({
      request: request({}, 'production-identity-migration-secret-that-is-long-enough'),
    } as Parameters<typeof PUT>[0])

    expect(response.status).toBe(401)
    expect(identitySync.synchronizeIdentityBatch).not.toHaveBeenCalled()
  })

  it('rejects duplicate source identities in a batch', async () => {
    configure()
    const duplicate = {
      source_user_id: '42',
      email: 'other@example.com',
      password_hash: passwordHash,
      state: 'active',
      memberships: [],
    }
    const base = (await request().json()) as { identities: unknown[] }

    const response = await PUT({
      request: request({ identities: [...base.identities, duplicate] }),
    } as Parameters<typeof PUT>[0])

    expect(response.status).toBe(400)
    expect(identitySync.synchronizeIdentityBatch).not.toHaveBeenCalled()
  })

  it('accepts a revoked identity without transporting a password hash', async () => {
    configure()
    identitySync.synchronizeIdentityBatch.mockResolvedValue({
      request_sha256: 'b'.repeat(64),
      source: 'freightclaims-fc-staging',
      source_snapshot: '20260729T230000Z-staging-shadow-test',
      synchronized: 1,
      created: 0,
      linked: 0,
      revoked: 1,
      skipped: 1,
      identities: [],
    })

    const response = await PUT({
      request: request({
        identities: [
          {
            source_user_id: '43',
            email: 'revoked@example.com',
            state: 'revoked',
            memberships: [],
          },
        ],
      }),
    } as Parameters<typeof PUT>[0])

    expect(response.status).toBe(200)
    expect(identitySync.synchronizeIdentityBatch.mock.calls[0]?.[0].identities).toEqual([
      {
        sourceUserId: '43',
        email: 'revoked@example.com',
        state: 'revoked',
        memberships: [],
      },
    ])
  })
})
