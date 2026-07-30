import { error, fail, redirect } from '@sveltejs/kit'
import { productForClient } from '$lib/server/admission'
import { authBrandForProduct } from '$lib/server/auth-brand'
import { acceptLogout, getLogoutRequest, rejectLogout } from '$lib/server/ory'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ url }) => {
  const challenge = url.searchParams.get('logout_challenge')
  if (!challenge) error(400, 'Missing logout challenge')
  const logout = await getLogoutRequest(challenge)
  if (logout.client) {
    const authBrand = authBrandForProduct(productForClient(logout.client))
    if (url.origin !== authBrand.authOrigin) {
      redirect(303, new URL(`${url.pathname}${url.search}`, authBrand.authOrigin).toString())
    }
  }
  return {
    challenge,
    clientName: logout.client?.client_name ?? logout.client?.client_id ?? 'this application',
  }
}

export const actions: Actions = {
  confirm: async ({ request }) => {
    const form = await request.formData()
    const challenge = form.get('challenge')
    if (typeof challenge !== 'string') return fail(400)
    const accepted = await acceptLogout(challenge)
    redirect(303, accepted.redirect_to)
  },
  cancel: async ({ request }) => {
    const form = await request.formData()
    const challenge = form.get('challenge')
    if (typeof challenge !== 'string') return fail(400)
    await rejectLogout(challenge)
    redirect(303, '/')
  },
}
