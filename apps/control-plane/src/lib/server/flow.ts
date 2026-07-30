import { redirect } from '@sveltejs/kit'
import { authBrandForHostname } from './auth-brand'
import { getKratosFlow } from './ory'
import { safeReturnUrl } from './return-url'

export async function loadFlow(
  kind: 'login' | 'settings' | 'recovery' | 'verification',
  url: URL,
  cookie: string | null,
) {
  const flowId = url.searchParams.get('flow')
  if (!flowId) {
    const authOrigin = authBrandForHostname(url.hostname).authOrigin
    const start = new URL(`self-service/${kind}/browser`, `${authOrigin}/`)
    const requestedReturn = safeReturnUrl(url.searchParams.get('return_to'), authOrigin)
    start.searchParams.set('return_to', requestedReturn)
    redirect(303, start.toString())
  }

  return {
    flow: await getKratosFlow(kind, flowId, cookie),
  }
}
