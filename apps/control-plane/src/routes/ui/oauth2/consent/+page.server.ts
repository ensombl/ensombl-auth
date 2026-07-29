import { error, fail, redirect } from '@sveltejs/kit'
import {
  admissionScopeForClient,
  evaluateAdmission,
  identityClaims,
  productForClient,
} from '$lib/server/admission'
import { config } from '$lib/server/config'
import { acceptConsent, getConsentRequest, getKratosSession, rejectConsent } from '$lib/server/ory'
import type { Actions, PageServerLoad } from './$types'

async function context(challenge: string, cookie: string | null) {
  const consent = await getConsentRequest(challenge)
  const session = await getKratosSession(cookie)
  if (!session || session.identity.id !== consent.subject) {
    error(403, 'The active identity does not match this consent request')
  }
  const product = productForClient(consent.client)
  const admissionScope = admissionScopeForClient(consent.client)
  const admission = await evaluateAdmission(session, admissionScope)
  if (admission !== 'allowed') error(403, 'Identity admission changed during sign-in')
  return { admissionScope, consent, session, product }
}

async function approve(challenge: string, cookie: string | null) {
  const { admissionScope, consent, session, product } = await context(challenge, cookie)
  return acceptConsent(challenge, {
    grant_scope: consent.requested_scope ?? [],
    grant_access_token_audience: consent.requested_access_token_audience ?? [],
    remember: true,
    remember_for: 43_200,
    session: {
      id_token: {
        ...identityClaims(session),
        admission_scope: admissionScope,
        product,
      },
      access_token: {
        admission_scope: admissionScope,
        product,
      },
    },
  })
}

export const load: PageServerLoad = async ({ url, request }) => {
  const challenge = url.searchParams.get('consent_challenge')
  if (!challenge) error(400, 'Missing consent challenge')

  const { consent } = await context(challenge, request.headers.get('cookie'))
  if (consent.skip || config().trustedClientIds.has(consent.client.client_id)) {
    const accepted = await approve(challenge, request.headers.get('cookie'))
    redirect(303, accepted.redirect_to)
  }

  return {
    challenge,
    clientName: consent.client.client_name ?? consent.client.client_id,
    scopes: consent.requested_scope ?? [],
  }
}

export const actions: Actions = {
  approve: async ({ request, cookies }) => {
    const form = await request.formData()
    const challenge = form.get('challenge')
    if (typeof challenge !== 'string') return fail(400)
    const accepted = await approve(
      challenge,
      cookies
        .getAll()
        .map((item) => `${item.name}=${item.value}`)
        .join('; '),
    )
    redirect(303, accepted.redirect_to)
  },
  deny: async ({ request }) => {
    const form = await request.formData()
    const challenge = form.get('challenge')
    if (typeof challenge !== 'string') return fail(400)
    const rejected = await rejectConsent(challenge)
    redirect(303, rejected.redirect_to)
  },
}
