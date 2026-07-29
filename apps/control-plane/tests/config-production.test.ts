import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { config, resetConfigForTest } from '../src/lib/server/config'

const originalEnvironment = { ...process.env }
const productCatalogPath = resolve(process.cwd(), '../../deploy/products/products.json')

function setProductionEnvironment(): void {
  Object.assign(process.env, {
    NODE_ENV: 'production',
    PUBLIC_AUTH_URL: 'https://auth.ensombl.io',
    KRATOS_PUBLIC_INTERNAL_URL: 'http://kratos:4433',
    KRATOS_ADMIN_URL: 'http://kratos:4434',
    HYDRA_ADMIN_URL: 'http://hydra:4445',
    KETO_READ_URL: 'http://keto:4466',
    KETO_WRITE_URL: 'http://keto:4467',
    DATABASE_URL: 'postgres://auth_control_runtime:production-password@postgres:5432/auth_control',
    ORY_HOOK_SECRET: 'production-hook-secret-that-is-not-the-default',
    MIGRATION_API_SECRET: 'production-migration-secret-that-is-not-the-default',
    INVITATION_RECONCILER_SECRET: 'production-reconciler-secret-that-is-not-the-default',
    FREIGHTCLAIMS_STAGING_AUTHORIZATION_DECISION_SECRET:
      'stage-authorization-decision-secret-that-is-long-enough',
    FREIGHTCLAIMS_PRODUCTION_AUTHORIZATION_DECISION_SECRET:
      'prod-authorization-decision-secret-that-is-long-enough',
    FREIGHTCLAIMS_STAGING_IDENTITY_MANAGEMENT_SECRET:
      'stage-identity-management-secret-that-is-long-enough',
    FREIGHTCLAIMS_PRODUCTION_IDENTITY_MANAGEMENT_SECRET:
      'prod-identity-management-secret-that-is-long-enough',
    FREIGHTCLAIMS_STAGING_IDENTITY_MIGRATION_SECRET:
      'stage-identity-migration-secret-that-is-long-enough',
    FREIGHTCLAIMS_PRODUCTION_IDENTITY_MIGRATION_SECRET:
      'prod-identity-migration-secret-that-is-long-enough',
    PRODUCT_CATALOG_PATH: productCatalogPath,
  })
  resetConfigForTest()
}

afterEach(() => {
  process.env = { ...originalEnvironment }
  resetConfigForTest()
})

describe('production configuration', () => {
  it('accepts the explicit Dokploy service topology', () => {
    setProductionEnvironment()

    expect(config()).toMatchObject({
      NODE_ENV: 'production',
      PUBLIC_AUTH_URL: 'https://auth.ensombl.io',
      KRATOS_PUBLIC_INTERNAL_URL: 'http://kratos:4433',
      DATABASE_URL:
        'postgres://auth_control_runtime:production-password@postgres:5432/auth_control',
    })
  })

  it('fails closed instead of applying development defaults', () => {
    process.env = { ...originalEnvironment, NODE_ENV: 'production' }
    for (const key of [
      'PUBLIC_AUTH_URL',
      'KRATOS_PUBLIC_INTERNAL_URL',
      'KRATOS_ADMIN_URL',
      'HYDRA_ADMIN_URL',
      'KETO_READ_URL',
      'KETO_WRITE_URL',
      'DATABASE_URL',
      'ORY_HOOK_SECRET',
      'MIGRATION_API_SECRET',
      'INVITATION_RECONCILER_SECRET',
      'PRODUCT_CATALOG_PATH',
    ]) {
      delete process.env[key]
    }
    resetConfigForTest()

    expect(() => config()).toThrow(/PUBLIC_AUTH_URL must be explicitly configured/)
    expect(() => config()).toThrow(/DATABASE_URL must be explicitly configured/)
    expect(() => config()).toThrow(/ORY_HOOK_SECRET must be explicitly configured/)
  })

  it.each([
    ['PUBLIC_AUTH_URL', 'http://auth.ensombl.io', 'PUBLIC_AUTH_URL'],
    ['PRODUCT_CATALOG_PATH', 'deploy/products/products.json', 'PRODUCT_CATALOG_PATH'],
    ['KRATOS_ADMIN_URL', 'http://localhost:24434', 'KRATOS_ADMIN_URL'],
    [
      'DATABASE_URL',
      'postgres://auth_control:production-password@127.0.0.1:5432/auth_control',
      'DATABASE_URL',
    ],
  ])('rejects insecure or local %s', (key, value, expectedMessage) => {
    setProductionEnvironment()
    process.env[key] = value
    resetConfigForTest()

    expect(() => config()).toThrow(expectedMessage)
  })

  it.each([
    ['ORY_HOOK_SECRET', 'local-only-hook-secret-32-bytes'],
    ['MIGRATION_API_SECRET', 'local-only-migration-api-secret'],
    ['INVITATION_RECONCILER_SECRET', 'local-only-invitation-reconciler-secret'],
  ])('rejects the development value for %s', (key, value) => {
    setProductionEnvironment()
    process.env[key] = value
    resetConfigForTest()

    expect(() => config()).toThrow(`${key} must not use the development secret`)
  })

  it('requires every production bearer secret to be pairwise unique', () => {
    const keys = [
      'ORY_HOOK_SECRET',
      'MIGRATION_API_SECRET',
      'INVITATION_RECONCILER_SECRET',
    ] as const

    for (let left = 0; left < keys.length; left += 1) {
      for (let right = left + 1; right < keys.length; right += 1) {
        setProductionEnvironment()
        const leftKey = keys[left]
        const rightKey = keys[right]
        if (!leftKey || !rightKey) throw new Error('Invalid test pair')
        process.env[rightKey] = process.env[leftKey]
        resetConfigForTest()

        expect(() => config()).toThrow(`${rightKey} must differ from ${leftKey}`)
      }
    }
  })

  it('requires all product capability secrets to be pairwise unique', () => {
    setProductionEnvironment()
    process.env.FREIGHTCLAIMS_STAGING_IDENTITY_MANAGEMENT_SECRET =
      process.env.FREIGHTCLAIMS_STAGING_AUTHORIZATION_DECISION_SECRET
    resetConfigForTest()

    expect(() => config()).toThrow('Product client capability secrets must be pairwise unique')
  })
})
