import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { config } from '$lib/server/config'
import { hasBearer } from '$lib/server/internal-auth'
import { hasTenantPermissionStrict } from '$lib/server/keto'
import type { RequestHandler } from './$types'

const bodySchema = z
  .object({
    client_id: z.string().regex(/^[A-Za-z0-9._-]+$/),
    subject_id: z.string().uuid(),
    tenant_id: z.string().trim().min(1).max(200),
    permission: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  })
  .strict()

export const POST: RequestHandler = async ({ request }) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, { status: 400 })

  const current = config()
  const admissionScope = current.admissionScopeByClient.get(parsed.data.client_id)
  const rolePolicy = current.tenantRolePolicyByAdmissionScope.get(admissionScope ?? '')
  const expectedSecret = current.authorizationDecisionSecrets.get(parsed.data.client_id)
  if (!admissionScope || !rolePolicy || !expectedSecret || !hasBearer(request, expectedSecret)) {
    return json({ error: 'unauthorized' }, { status: 401 })
  }
  if (
    ![...rolePolicy.roles.values()].some((role) => role.permissions.has(parsed.data.permission))
  ) {
    return json({ error: 'invalid_permission' }, { status: 400 })
  }

  try {
    const allowed = await hasTenantPermissionStrict(
      parsed.data.subject_id,
      admissionScope,
      parsed.data.tenant_id,
      parsed.data.permission,
      rolePolicy,
    )
    return json({ allowed })
  } catch {
    return json({ error: 'authorization_unavailable' }, { status: 503 })
  }
}
