import { randomUUID } from 'node:crypto'
import { error, fail, redirect } from '@sveltejs/kit'
import { z } from 'zod'
import { config } from '$lib/server/config'
import {
  authorizeInvitationOperator,
  invitationFormOriginAllowed,
  invitationOperatorAccess,
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

function canonicalAdminUrl(product: string): URL {
  const target = new URL('/ui/admin/invitations', config().PUBLIC_AUTH_URL)
  target.searchParams.set('product', product)
  return target
}

export const load: PageServerLoad = async ({ url, request }) => {
  const defaultProduct = config().clientProductMap.values().next().value
  if (!defaultProduct) error(503, 'No Ensombl product is configured')
  const product = url.searchParams.get('product') ?? defaultProduct
  requireKnownProduct(product)

  const target = canonicalAdminUrl(product)
  if (url.origin !== target.origin || url.pathname !== target.pathname) {
    redirect(303, target.toString())
  }

  const access = await invitationOperatorAccess(cookieHeader(request), product)
  if (access.state === 'login_required') {
    const login = new URL('/self-service/login/browser', config().PUBLIC_AUTH_URL)
    login.searchParams.set('return_to', target.toString())
    redirect(303, login.toString())
  }
  if (access.state === 'password_reset_required') {
    const settings = new URL('/self-service/settings/browser', config().PUBLIC_AUTH_URL)
    settings.searchParams.set('return_to', target.toString())
    redirect(303, settings.toString())
  }
  if (access.state === 'product_administrator_required') {
    error(403, `Product administrator permission is required for ${product}`)
  }
  if (access.state === 'aal2_required') {
    const login = new URL('/self-service/login/browser', config().PUBLIC_AUTH_URL)
    login.searchParams.set('aal', 'aal2')
    login.searchParams.set('refresh', 'true')
    login.searchParams.set('return_to', target.toString())
    redirect(303, login.toString())
  }

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
