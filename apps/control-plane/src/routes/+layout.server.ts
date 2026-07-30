import { authBrandForHostname } from '$lib/server/auth-brand'
import type { LayoutServerLoad } from './$types'

export const load: LayoutServerLoad = ({ url }) => {
  const brand = authBrandForHostname(url.hostname)
  return {
    authBrand: {
      id: brand.id,
      displayName: brand.displayName,
    },
  }
}
