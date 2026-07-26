import { config } from '$lib/server/config'
import { fetchJson } from '$lib/server/http'
import type { PageServerLoad } from './$types'

type KratosError = {
  error?: {
    code?: number
    message?: string
    reason?: string
  }
}

export const load: PageServerLoad = async ({ url }) => {
  const id = url.searchParams.get('id')
  if (!id) return { message: 'The identity request could not be completed.' }

  const endpoint = new URL('self-service/errors', `${config().KRATOS_PUBLIC_INTERNAL_URL}/`)
  endpoint.searchParams.set('id', id)
  const result = await fetchJson<KratosError>(endpoint)
  return {
    message:
      result.error?.reason ??
      result.error?.message ??
      'The identity request could not be completed.',
  }
}
