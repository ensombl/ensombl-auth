import { redirect } from '@sveltejs/kit'
import { config } from './config'
import { getKratosFlow } from './ory'
import { safeReturnUrl } from './return-url'

export async function loadFlow(
  kind: 'login' | 'settings' | 'recovery' | 'verification',
  url: URL,
  cookie: string | null,
) {
  const flowId = url.searchParams.get('flow')
  if (!flowId) {
    const start = new URL(`self-service/${kind}/browser`, `${config().PUBLIC_AUTH_URL}/`)
    const requestedReturn = safeReturnUrl(
      url.searchParams.get('return_to'),
      config().PUBLIC_AUTH_URL,
    )
    start.searchParams.set('return_to', requestedReturn)
    redirect(303, start.toString())
  }

  return {
    flow: await getKratosFlow(kind, flowId, cookie),
  }
}
