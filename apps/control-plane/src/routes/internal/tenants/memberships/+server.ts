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
    tenant_id: z.string().trim().min(1).max(200),
    role: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    state: z.enum(['active', 'revoked']),
  })
  .strict()

export const PUT: RequestHandler = async ({ request }) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, { status: 400 })

  const current = config()
  const admissionScope = current.admissionScopeByClient.get(parsed.data.client_id)
  const rolePolicy = current.tenantRolePolicyByAdmissionScope.get(admissionScope ?? '')
  const expectedSecret = current.identityManagementSecrets.get(parsed.data.client_id)
  if (!admissionScope || !rolePolicy || !expectedSecret || !hasBearer(request, expectedSecret)) {
    return json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!rolePolicy.roles.has(parsed.data.role)) {
    return json({ error: 'invalid_role' }, { status: 400 })
  }

  try {
    await setTenantMembership({
      identityId: parsed.data.identity_id,
      tenantId: parsed.data.tenant_id,
      product: admissionScope,
      role: parsed.data.role,
      rolePolicy,
      state: parsed.data.state,
    })
    return new Response(null, { status: 204 })
  } catch {
    return json({ error: 'identity_management_unavailable' }, { status: 503 })
  }
}
