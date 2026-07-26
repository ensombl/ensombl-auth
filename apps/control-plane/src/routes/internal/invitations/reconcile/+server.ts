import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { config } from '$lib/server/config'
import { hasBearer } from '$lib/server/internal-auth'
import { InvitationUnavailableError, reconcileInvitationActivations } from '$lib/server/invitations'
import type { RequestHandler } from './$types'

const bodySchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
})

export const POST: RequestHandler = async ({ request }) => {
  if (!hasBearer(request, config().INVITATION_RECONCILER_SECRET)) {
    return json({ error: 'unauthorized' }, { status: 401 })
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return json({ error: 'invalid_request' }, { status: 400 })

  try {
    const reconciled = await reconcileInvitationActivations(parsed.data.limit)
    return json({ reconciled })
  } catch (caught) {
    if (caught instanceof InvitationUnavailableError) {
      return json({ error: 'reconciliation_incomplete' }, { status: 503 })
    }
    throw caught
  }
}
