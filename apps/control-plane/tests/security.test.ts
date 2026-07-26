import { afterEach, describe, expect, it } from 'vitest'
import { productForClient } from '../src/lib/server/admission'
import { config, resetConfigForTest } from '../src/lib/server/config'
import { hasBearer } from '../src/lib/server/internal-auth'
import { safeReturnUrl } from '../src/lib/server/return-url'

const original = { ...process.env }

afterEach(() => {
  process.env = { ...original }
  resetConfigForTest()
})

describe('safeReturnUrl', () => {
  it('allows only the auth and configured product origins', () => {
    process.env.PUBLIC_AUTH_URL = 'https://auth.ensombl.io'
    process.env.FREIGHTCLAIMS_BASE_URL = 'https://freightclaims.ensombl.io'
    resetConfigForTest()

    expect(safeReturnUrl('https://auth.ensombl.io/ui/login')).toBe(
      'https://auth.ensombl.io/ui/login',
    )
    expect(safeReturnUrl('https://freightclaims.ensombl.io/claims')).toBe(
      'https://freightclaims.ensombl.io/claims',
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
    process.env.CLIENT_PRODUCT_MAP_JSON = '{"freightclaims-web":"freightclaims"}'
    process.env.TRUSTED_CLIENT_IDS = 'freightclaims-web'
    resetConfigForTest()

    expect(config().clientProductMap.get('freightclaims-web')).toBe('freightclaims')
    expect(config().trustedClientIds.has('freightclaims-web')).toBe(true)
    expect(config().trustedClientIds.has('unknown-client')).toBe(false)
  })

  it('makes the explicit client map authoritative over Hydra metadata', () => {
    process.env.CLIENT_PRODUCT_MAP_JSON = '{"freightclaims-web":"freightclaims"}'
    resetConfigForTest()

    expect(
      productForClient({
        client_id: 'freightclaims-web',
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
        client_id: 'freightclaims-web',
        metadata: { ensombl_product: 'another-product' },
      }),
    ).toThrow()
  })
})
