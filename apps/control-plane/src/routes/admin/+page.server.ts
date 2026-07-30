import { error, redirect } from '@sveltejs/kit'
import { adminConsoleAccess } from '$lib/server/admin-console'
import { config } from '$lib/server/config'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ request, url }) => {
  const configured = config()
  const target = new URL('/admin', configured.PUBLIC_AUTH_URL)
  if (url.origin !== target.origin || url.pathname !== target.pathname) {
    redirect(303, target.toString())
  }

  const products = [...configured.authBrandByProduct].map(([id, brand]) => ({
    id,
    displayName: brand.displayName,
  }))
  if (products.length === 0) error(503, 'No Ensombl product is configured')

  const access = await adminConsoleAccess(request.headers.get('cookie'), products)
  if (access.state === 'login_required') {
    const login = new URL('/self-service/login/browser', configured.PUBLIC_AUTH_URL)
    login.searchParams.set('return_to', target.toString())
    redirect(303, login.toString())
  }
  if (access.state === 'password_reset_required') {
    const settings = new URL('/self-service/settings/browser', configured.PUBLIC_AUTH_URL)
    settings.searchParams.set('return_to', target.toString())
    redirect(303, settings.toString())
  }
  if (access.state === 'product_administrator_required') {
    error(403, 'Product administrator permission is required')
  }

  return { products: access.products }
}
