import { randomUUID } from 'node:crypto'
import { error, fail } from '@sveltejs/kit'
import { z } from 'zod'
import { config } from '$lib/server/config'
import {
  authorizeInvitationOperator,
  invitationFormOriginAllowed,
} from '$lib/server/invitation-operator'
import {
  InvitationConflictError,
  InvitationUnavailableError,
  issueInvitation,
} from '$lib/server/invitations'
import type { Actions, PageServerLoad } from './$types'

const formSchema = z.object({
  email: z.string().email().max(320),
  product: z.string().min(1).max(100),
  expires_in_hours: z.coerce.number().int().min(1).max(168),
  idempotency_key: z.string().uuid(),
})

function cookieHeader(request: Request): string | null {
  return request.headers.get('cookie')
}

function requireTrustedOrigin(request: Request): void {
  if (!invitationFormOriginAllowed(request.headers.get('origin'), config().PUBLIC_AUTH_URL)) {
    error(403, 'Cross-origin invitation submission rejected')
  }
}

function requireKnownProduct(product: string): void {
  if (!new Set(config().clientProductMap.values()).has(product)) {
    error(400, 'Unknown product')
  }
}

export const load: PageServerLoad = async ({ url, request }) => {
  const defaultProduct = config().clientProductMap.values().next().value
  if (!defaultProduct) error(503, 'No Ensombl product is configured')
  const product = url.searchParams.get('product') ?? defaultProduct
  requireKnownProduct(product)
  await authorizeInvitationOperator(cookieHeader(request), product)
  return { product, idempotencyKey: randomUUID() }
}

export const actions: Actions = {
  default: async ({ request }) => {
    requireTrustedOrigin(request)
    const form = await request.formData()
    const parsed = formSchema.safeParse(Object.fromEntries(form))
    if (!parsed.success) return fail(400, { error: 'invalid_request' })
    requireKnownProduct(parsed.data.product)

    const invitedBy = await authorizeInvitationOperator(cookieHeader(request), parsed.data.product)
    try {
      const result = await issueInvitation({
        email: parsed.data.email.trim().toLowerCase(),
        product: parsed.data.product,
        invitedBy,
        expiresInHours: parsed.data.expires_in_hours,
        idempotencyKey: parsed.data.idempotency_key,
      })
      return {
        ok: true,
        invitationId: result.invitation.id,
        state: result.processing ? 'processing' : result.invitation.state,
        nextIdempotencyKey: randomUUID(),
      }
    } catch (caught) {
      if (caught instanceof InvitationConflictError) {
        return fail(409, { error: 'idempotency_conflict' })
      }
      if (caught instanceof InvitationUnavailableError) {
        return fail(503, { error: 'invitation_temporarily_unavailable' })
      }
      throw caught
    }
  },
}
