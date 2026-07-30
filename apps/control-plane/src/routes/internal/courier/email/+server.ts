import { json } from '@sveltejs/kit'
import { courierEmailSchema, sendAuthEmail } from '$lib/server/auth-email'
import { config } from '$lib/server/config'
import { hasBearer } from '$lib/server/internal-auth'
import type { RequestHandler } from './$types'

export const POST: RequestHandler = async ({ request }) => {
  if (!hasBearer(request, config().AUTH_COURIER_SECRET)) {
    return json({ error: 'unauthorized' }, { status: 401 })
  }

  const parsed = courierEmailSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_courier_payload' }, { status: 400 })

  try {
    await sendAuthEmail(parsed.data)
  } catch (error) {
    if (error instanceof Error && error.message === 'unknown_auth_product') {
      return json({ error: 'unknown_auth_product' }, { status: 400 })
    }
    throw error
  }

  return json({ ok: true })
}
