import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { config } from '$lib/server/config'
import { hasBearer } from '$lib/server/internal-auth'
import { setTenantMembership } from '$lib/server/keto'
import type { RequestHandler } from './$types'

const bodySchema = z
  .object({
    client_id: z.string().regex(/^[A-Za-z0-9._-]+$/),
    identity_id: z.string().uuid(),
    organization_id: z.string().uuid(),
    relation: z.enum(['members', 'administrators']),
    state: z.enum(['active', 'revoked']),
  })
  .strict()

export const PUT: RequestHandler = async ({ request }) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, { status: 400 })

  const current = config()
  const product = current.clientProductMap.get(parsed.data.client_id)
  const expectedSecret = current.identityManagementSecrets.get(parsed.data.client_id)
  if (!product || !expectedSecret || !hasBearer(request, expectedSecret)) {
    return json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    await setTenantMembership({
      identityId: parsed.data.identity_id,
      organizationId: parsed.data.organization_id,
      product,
      relation: parsed.data.relation,
      state: parsed.data.state,
    })
    return new Response(null, { status: 204 })
  } catch {
    return json({ error: 'identity_management_unavailable' }, { status: 503 })
  }
}
