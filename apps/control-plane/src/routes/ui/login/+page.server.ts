import { loadFlow } from '$lib/server/flow'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = ({ url, request }) =>
  loadFlow('login', url, request.headers.get('cookie'))
