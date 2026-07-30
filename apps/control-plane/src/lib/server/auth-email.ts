import { z } from 'zod'
import { authBrandForMarker } from './auth-brand'
import { config } from './config'

export const AUTH_PRODUCT_HEADER = 'x-ensombl-auth-product'

const headerValue = z.union([z.string(), z.array(z.string())])

export const courierEmailSchema = z.object({
  recipient: z.string().email().max(320),
  subject: z.string().min(1).max(998),
  body: z.string().max(1_000_000),
  html_body: z.string().max(2_000_000).nullish(),
  template_type: z.string().min(1).max(100),
  message_type: z.literal('email'),
  request_headers: z.record(z.string(), headerValue).default({}),
})

export type CourierEmail = z.infer<typeof courierEmailSchema>

function firstHeader(
  headers: Record<string, string | string[]>,
  expectedName: string,
): string | undefined {
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === expectedName.toLowerCase(),
  )
  const value = entry?.[1]
  return Array.isArray(value) ? value[0] : value
}

export async function sendAuthEmail(
  message: CourierEmail,
  request: typeof fetch = fetch,
): Promise<void> {
  const configured = config()
  const marker = firstHeader(message.request_headers, AUTH_PRODUCT_HEADER)
  const brand = authBrandForMarker(marker)
  const response = await request('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${configured.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `${brand.emailFromName} <${configured.emailFromAddress}>`,
      to: [message.recipient],
      subject: message.subject,
      text: message.body,
      ...(message.html_body ? { html: message.html_body } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    console.error('Resend auth email delivery failed', {
      status: response.status,
      templateType: message.template_type,
      authProduct: brand.id,
    })
    throw new Error('auth_email_delivery_failed')
  }
}
