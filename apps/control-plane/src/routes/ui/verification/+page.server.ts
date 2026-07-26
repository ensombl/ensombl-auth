import { loadFlow } from '$lib/server/flow'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = ({ url, request }) =>
  loadFlow('verification', url, request.headers.get('cookie'))
