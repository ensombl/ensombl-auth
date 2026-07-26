import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { config } from '$lib/server/config'
import { hasBearer } from '$lib/server/internal-auth'
import { completePasswordChange } from '$lib/server/password-change'
import type { RequestHandler } from './$types'

const bodySchema = z.object({
  event_id: z.string().min(1).max(300),
  identity_id: z.string().uuid(),
  flow_id: z.string().min(1).max(200),
  session_id: z.string().min(1).max(200).optional(),
})

export const POST: RequestHandler = async ({ request }) => {
  if (!hasBearer(request, config().ORY_HOOK_SECRET)) {
    return json({ error: 'unauthorized' }, { status: 401 })
  }

  const parsed = bodySchema.safeParse(await request.json())
  if (!parsed.success) return json({ error: 'invalid_hook_payload' }, { status: 400 })

  await completePasswordChange({
    eventId: parsed.data.event_id,
    identityId: parsed.data.identity_id,
    flowId: parsed.data.flow_id,
    ...(parsed.data.session_id ? { sessionId: parsed.data.session_id } : {}),
  })
  return json({ ok: true })
}
