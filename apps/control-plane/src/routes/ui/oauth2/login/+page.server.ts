import { error, redirect } from '@sveltejs/kit'
import { evaluateAdmission, productForClient } from '$lib/server/admission'
import { config } from '$lib/server/config'
import { acceptLogin, getKratosSession, getLoginRequest, rejectLogin } from '$lib/server/ory'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ url, request }) => {
  const challenge = url.searchParams.get('login_challenge')
  if (!challenge) error(400, 'Missing login challenge')

  const login = await getLoginRequest(challenge)
  const product = productForClient(login.client)
  const cookie = request.headers.get('cookie')
  const session = await getKratosSession(cookie)

  if (!session) {
    const start = new URL('self-service/login/browser', `${config().PUBLIC_AUTH_URL}/`)
    start.searchParams.set('return_to', url.toString())
    redirect(303, start.toString())
  }

  const admission = await evaluateAdmission(session, product)
  if (admission === 'reset_required') {
    const settings = new URL('self-service/settings/browser', `${config().PUBLIC_AUTH_URL}/`)
    settings.searchParams.set('return_to', url.toString())
    redirect(303, settings.toString())
  }
  if (admission === 'not_admitted') {
    const rejected = await rejectLogin(
      challenge,
      `This identity is not admitted to ${product}. Contact your administrator.`,
    )
    redirect(303, rejected.redirect_to)
  }

  if (login.skip && login.subject && login.subject !== session.identity.id) {
    error(403, 'The active identity does not match the remembered OAuth session')
  }

  const accepted = await acceptLogin(challenge, {
    subject: session.identity.id,
    remember: true,
    remember_for: 43_200,
    context: { product },
    identity_provider_session_id: session.id,
  })
  redirect(303, accepted.redirect_to)
}
