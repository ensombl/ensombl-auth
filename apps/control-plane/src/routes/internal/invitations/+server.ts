import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { config } from '$lib/server/config'
import { hasBearer } from '$lib/server/internal-auth'
import {
  InvitationConflictError,
  InvitationUnavailableError,
  issueInvitation,
} from '$lib/server/invitations'
import type { RequestHandler } from './$types'

const bodySchema = z.object({
  email: z.string().email().max(320),
  product: z.string().min(1).max(100),
  expires_in_hours: z.number().int().min(1).max(168).default(48),
})

const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/)

export const POST: RequestHandler = async ({ request }) => {
  if (!hasBearer(request, config().INVITATION_API_SECRET)) {
    return json({ error: 'unauthorized' }, { status: 401 })
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'))
  if (!parsed.success || !idempotencyKey.success) {
    return json({ error: 'invalid_request' }, { status: 400 })
  }

  const knownProducts = new Set(config().clientProductMap.values())
  if (!knownProducts.has(parsed.data.product)) {
    return json({ error: 'unknown_product' }, { status: 400 })
  }

  try {
    const result = await issueInvitation({
      email: parsed.data.email.trim().toLowerCase(),
      product: parsed.data.product,
      invitedBy: config().INVITATION_SERVICE_ACTOR,
      expiresInHours: parsed.data.expires_in_hours,
      idempotencyKey: idempotencyKey.data,
    })
    const status = result.processing ? 202 : result.created ? 201 : 200

    return json(
      {
        invitation_id: result.invitation.id,
        identity_id: result.invitation.identityId,
        state: result.processing ? 'processing' : result.invitation.state,
        recovery_dispatched: result.invitation.state === 'dispatched',
        expires_at: result.invitation.expiresAt.toISOString(),
      },
      { status },
    )
  } catch (caught) {
    if (caught instanceof InvitationConflictError) {
      return json({ error: 'idempotency_conflict' }, { status: 409 })
    }
    if (caught instanceof InvitationUnavailableError) {
      return json({ error: 'invitation_temporarily_unavailable' }, { status: 503 })
    }
    throw caught
  }
}
