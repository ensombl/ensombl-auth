import { loadSettingsMode } from '$lib/server/settings-mode'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = ({ url, request }) =>
  loadSettingsMode(url, request.headers.get('cookie'))
