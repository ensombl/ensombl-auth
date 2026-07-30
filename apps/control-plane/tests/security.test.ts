import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { productForClient } from '../src/lib/server/admission'
import { config, resetConfigForTest } from '../src/lib/server/config'
import { hasBearer } from '../src/lib/server/internal-auth'
import { safeReturnUrl } from '../src/lib/server/return-url'

const original = { ...process.env }
const productCatalogPath = resolve(process.cwd(), '../../deploy/products/products.json')

afterEach(() => {
  process.env = { ...original }
  resetConfigForTest()
})

describe('safeReturnUrl', () => {
  it('allows only the auth and configured product origins', () => {
    process.env.PUBLIC_AUTH_URL = 'https://auth.ensombl.io'
    process.env.PRODUCT_CATALOG_PATH = productCatalogPath
    resetConfigForTest()

    expect(safeReturnUrl('https://auth.ensombl.io/ui/login')).toBe(
      'https://auth.ensombl.io/ui/login',
    )
    expect(safeReturnUrl('https://app.freightclaims.ensombl.io/claims')).toBe(
      'https://app.freightclaims.ensombl.io/claims',
    )
    expect(safeReturnUrl('https://attacker.example/callback')).toBe('/')
    expect(safeReturnUrl('//attacker.example/callback')).toBe('/')
    expect(safeReturnUrl('https://user:pass@auth.ensombl.io/')).toBe('/')
  })
})

describe('internal bearer authentication', () => {
  it('rejects missing, malformed, and unequal credentials', () => {
    const expected = 'a-secure-internal-secret'
    expect(hasBearer(new Request('http://local'), expected)).toBe(false)
    expect(
      hasBearer(
        new Request('http://local', { headers: { authorization: `Basic ${expected}` } }),
        expected,
      ),
    ).toBe(false)
    expect(
      hasBearer(
        new Request('http://local', { headers: { authorization: 'Bearer wrong-secret' } }),
        expected,
      ),
    ).toBe(false)
    expect(
      hasBearer(
        new Request('http://local', { headers: { authorization: `Bearer ${expected}` } }),
        expected,
      ),
    ).toBe(true)
  })
})

describe('configuration', () => {
  it('maps clients to products and trusted clients explicitly', () => {
    process.env.PRODUCT_CATALOG_PATH = productCatalogPath
    resetConfigForTest()

    expect(config().clientProductMap.get('freightclaims-production-web')).toBe('freightclaims')
    expect(config().admissionScopeByClient.get('freightclaims-staging-web')).toBe(
      'freightclaims:staging',
    )
    expect(config().admissionScopeByClient.get('freightclaims-production-web')).toBe(
      'freightclaims:production',
    )
    expect(config().trustedClientIds.has('freightclaims-production-web')).toBe(true)
    expect(config().trustedClientIds.has('unknown-client')).toBe(false)
  })

  it('makes the explicit client map authoritative over Hydra metadata', () => {
    process.env.PRODUCT_CATALOG_PATH = productCatalogPath
    resetConfigForTest()

    expect(
      productForClient({
        client_id: 'freightclaims-production-web',
        metadata: { ensombl_product: 'freightclaims' },
      }),
    ).toBe('freightclaims')
    expect(() =>
      productForClient({
        client_id: 'unmapped-client',
        metadata: { ensombl_product: 'freightclaims' },
      }),
    ).toThrow()
    expect(() =>
      productForClient({
        client_id: 'freightclaims-production-web',
        metadata: { ensombl_product: 'another-product' },
      }),
    ).toThrow()
  })
})
