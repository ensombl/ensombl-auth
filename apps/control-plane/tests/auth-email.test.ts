import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CourierEmail, sendAuthEmail } from '../src/lib/server/auth-email'
import { resetConfigForTest } from '../src/lib/server/config'

const originalEnvironment = { ...process.env }
const productCatalogPath = resolve(process.cwd(), '../../deploy/products/products.json')

function message(marker?: string): CourierEmail {
  return {
    recipient: 'user@example.test',
    subject: 'Your recovery code',
    body: 'Use 123456 to recover your account.',
    html_body: '<p>Use 123456 to recover your account.</p>',
    template_type: 'recovery_code_valid',
    message_type: 'email',
    request_headers: marker ? { 'X-Ensombl-Auth-Product': [marker] } : {},
  }
}

function configure(): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PRODUCT_CATALOG_PATH: productCatalogPath,
    RESEND_API_KEY: 're_test_api_key',
  })
  resetConfigForTest()
}

afterEach(() => {
  process.env = { ...originalEnvironment }
  resetConfigForTest()
})

describe('auth email branding', () => {
  it.each([
    [undefined, 'Ensombl <noreply@notifications.ensombl.io>'],
    ['ensombl', 'Ensombl <noreply@notifications.ensombl.io>'],
    ['freightclaims', 'FreightClaims <noreply@notifications.ensombl.io>'],
  ])('selects a reviewed sender for marker %s', async (marker, expectedFrom) => {
    configure()
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 'email-id' }), { status: 200 }),
    )

    await sendAuthEmail(message(marker), request as unknown as typeof fetch)

    const [, init] = request.mock.calls[0] ?? []
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer re_test_api_key',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(init?.body))).toMatchObject({
      from: expectedFrom,
      to: ['user@example.test'],
      subject: 'Your recovery code',
    })
  })

  it('rejects a marker that is absent from the reviewed catalog', async () => {
    configure()
    const request = vi.fn()

    await expect(
      sendAuthEmail(message('attacker-controlled'), request as unknown as typeof fetch),
    ).rejects.toThrow('unknown_auth_product')
    expect(request).not.toHaveBeenCalled()
  })

  it('fails closed when Resend rejects delivery', async () => {
    configure()
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 429 }),
    )

    await expect(
      sendAuthEmail(message('freightclaims'), request as unknown as typeof fetch),
    ).rejects.toThrow('auth_email_delivery_failed')
  })
})
