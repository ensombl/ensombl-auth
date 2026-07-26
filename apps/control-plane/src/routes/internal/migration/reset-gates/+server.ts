import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { config } from '$lib/server/config'
import { setResetGate } from '$lib/server/db'
import { hasBearer } from '$lib/server/internal-auth'
import type { RequestHandler } from './$types'

const bodySchema = z.object({
  identities: z
    .array(
      z.object({
        identity_id: z.string().uuid(),
        reset_required: z.literal(true),
        source: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(500),
})

export const PUT: RequestHandler = async ({ request }) => {
  if (!hasBearer(request, config().MIGRATION_API_SECRET)) {
    return json({ error: 'unauthorized' }, { status: 401 })
  }
  const parsed = bodySchema.safeParse(await request.json())
  if (!parsed.success) return json({ error: 'invalid_request' }, { status: 400 })

  for (const identity of parsed.data.identities) {
    await setResetGate({
      identityId: identity.identity_id,
      source: identity.source,
    })
  }
  return json({ updated: parsed.data.identities.length })
}
