import { error } from '@sveltejs/kit'
import { isResetRequired } from './db'
import { loadFlow } from './flow'
import { getKratosSession } from './ory'

type SettingsModeDependencies = {
  loadFlow: typeof loadFlow
  getKratosSession: typeof getKratosSession
  isResetRequired: typeof isResetRequired
}

const defaultDependencies: SettingsModeDependencies = {
  loadFlow,
  getKratosSession,
  isResetRequired,
}

export async function loadSettingsMode(
  url: URL,
  cookie: string | null,
  dependencies: SettingsModeDependencies = defaultDependencies,
) {
  const loaded = await dependencies.loadFlow('settings', url, cookie)
  const session = await dependencies.getKratosSession(cookie)

  if (!session?.active) {
    error(401, 'An active authentication session is required.')
  }

  return {
    ...loaded,
    forced: await dependencies.isResetRequired(session.identity.id),
  }
}
