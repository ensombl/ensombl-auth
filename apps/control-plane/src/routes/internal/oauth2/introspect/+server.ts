import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { config } from '$lib/server/config'
import { hasBearer } from '$lib/server/internal-auth'
import type { RequestHandler } from './$types'

const clientId = z.string().regex(/^[A-Za-z0-9._-]+$/)
const token = z.string().min(1).max(16_384)
const introspection = z
  .object({
    active: z.boolean(),
  })
  .passthrough()

export const POST: RequestHandler = async ({ request }) => {
  const form = await request.formData().catch(() => null)
  const parsedClientId = clientId.safeParse(form?.get('client_id'))
  const parsedToken = token.safeParse(form?.get('token'))
  if (!parsedClientId.success || !parsedToken.success) {
    return json({ error: 'invalid_request' }, { status: 400 })
  }

  const expectedSecret = config().authorizationDecisionSecrets.get(parsedClientId.data)
  if (!expectedSecret || !hasBearer(request, expectedSecret)) {
    return json({ error: 'unauthorized' }, { status: 401 })
  }

  const response = await fetch(new URL('admin/oauth2/introspect', `${config().HYDRA_ADMIN_URL}/`), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ token: parsedToken.data }),
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) return json({ error: 'introspection_unavailable' }, { status: 503 })

  const parsed = introspection.safeParse(await response.json().catch(() => null))
  if (!parsed.success) return json({ error: 'introspection_unavailable' }, { status: 503 })
  return json(parsed.data)
}
