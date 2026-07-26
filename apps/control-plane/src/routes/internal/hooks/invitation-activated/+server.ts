import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { config } from '$lib/server/config'
import { hasBearer } from '$lib/server/internal-auth'
import { activateInvitations, InvitationUnavailableError } from '$lib/server/invitations'
import type { RequestHandler } from './$types'

const bodySchema = z.object({
  event_id: z.string().min(1).max(300),
  identity_id: z.string().uuid(),
  flow_id: z.string().min(1).max(200),
})

export const POST: RequestHandler = async ({ request }) => {
  if (!hasBearer(request, config().ORY_HOOK_SECRET)) {
    return json({ error: 'unauthorized' }, { status: 401 })
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_hook_payload' }, { status: 400 })

  try {
    const activated = await activateInvitations({
      eventId: parsed.data.event_id,
      identityId: parsed.data.identity_id,
      flowId: parsed.data.flow_id,
    })
    return json({ ok: true, activated })
  } catch (caught) {
    if (caught instanceof InvitationUnavailableError) {
      return json({ error: 'activation_temporarily_unavailable' }, { status: 503 })
    }
    throw caught
  }
}
