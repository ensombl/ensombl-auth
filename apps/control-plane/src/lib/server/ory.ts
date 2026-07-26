import { config } from './config'
import { fetchJson } from './http'
import type {
  HydraConsentRequest,
  HydraLoginRequest,
  HydraLogoutRequest,
  KratosFlow,
  KratosSession,
  OryRedirect,
} from './types'

function withQuery(base: string, path: string, key: string, value: string): URL {
  const url = new URL(path, `${base}/`)
  url.searchParams.set(key, value)
  return url
}

export async function getKratosFlow(
  kind: 'login' | 'settings' | 'recovery' | 'verification',
  id: string,
  cookie: string | null,
): Promise<KratosFlow> {
  const url = withQuery(config().KRATOS_PUBLIC_INTERNAL_URL, `self-service/${kind}/flows`, 'id', id)
  return fetchJson<KratosFlow>(url, { headers: cookie ? { cookie } : {} })
}

export async function getKratosSession(cookie: string | null): Promise<KratosSession | null> {
  if (!cookie) return null
  const response = await fetch(
    new URL('sessions/whoami', `${config().KRATOS_PUBLIC_INTERNAL_URL}/`),
    {
      headers: { accept: 'application/json', cookie },
      signal: AbortSignal.timeout(5_000),
    },
  )
  if (response.status === 401) return null
  if (!response.ok) {
    console.error('Kratos session check failed', { status: response.status })
    return null
  }
  return (await response.json()) as KratosSession
}

export function revokeIdentitySessions(identityId: string): Promise<void> {
  return fetchJson(
    new URL(
      `admin/identities/${encodeURIComponent(identityId)}/sessions`,
      `${config().KRATOS_ADMIN_URL}/`,
    ),
    { method: 'DELETE' },
    [204],
  )
}

export function getLoginRequest(challenge: string): Promise<HydraLoginRequest> {
  return fetchJson(
    withQuery(
      config().HYDRA_ADMIN_URL,
      'admin/oauth2/auth/requests/login',
      'login_challenge',
      challenge,
    ),
  )
}

export function acceptLogin(
  challenge: string,
  body: {
    subject: string
    remember: boolean
    remember_for: number
    context: Record<string, unknown>
    identity_provider_session_id: string
  },
): Promise<OryRedirect> {
  return fetchJson(
    withQuery(
      config().HYDRA_ADMIN_URL,
      'admin/oauth2/auth/requests/login/accept',
      'login_challenge',
      challenge,
    ),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

export function rejectLogin(challenge: string, description: string): Promise<OryRedirect> {
  return fetchJson(
    withQuery(
      config().HYDRA_ADMIN_URL,
      'admin/oauth2/auth/requests/login/reject',
      'login_challenge',
      challenge,
    ),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: 'access_denied',
        error_description: description,
      }),
    },
  )
}

export function getConsentRequest(challenge: string): Promise<HydraConsentRequest> {
  return fetchJson(
    withQuery(
      config().HYDRA_ADMIN_URL,
      'admin/oauth2/auth/requests/consent',
      'consent_challenge',
      challenge,
    ),
  )
}

export function acceptConsent(
  challenge: string,
  body: {
    grant_scope: string[]
    grant_access_token_audience: string[]
    remember: boolean
    remember_for: number
    session: {
      id_token: Record<string, unknown>
      access_token: Record<string, unknown>
    }
  },
): Promise<OryRedirect> {
  return fetchJson(
    withQuery(
      config().HYDRA_ADMIN_URL,
      'admin/oauth2/auth/requests/consent/accept',
      'consent_challenge',
      challenge,
    ),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

export function rejectConsent(challenge: string): Promise<OryRedirect> {
  return fetchJson(
    withQuery(
      config().HYDRA_ADMIN_URL,
      'admin/oauth2/auth/requests/consent/reject',
      'consent_challenge',
      challenge,
    ),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: 'access_denied',
        error_description: 'The user denied access.',
      }),
    },
  )
}

export function getLogoutRequest(challenge: string): Promise<HydraLogoutRequest> {
  return fetchJson(
    withQuery(
      config().HYDRA_ADMIN_URL,
      'admin/oauth2/auth/requests/logout',
      'logout_challenge',
      challenge,
    ),
  )
}

export function acceptLogout(challenge: string): Promise<OryRedirect> {
  return fetchJson(
    withQuery(
      config().HYDRA_ADMIN_URL,
      'admin/oauth2/auth/requests/logout/accept',
      'logout_challenge',
      challenge,
    ),
    { method: 'PUT' },
  )
}

export function rejectLogout(challenge: string): Promise<void> {
  return fetchJson(
    withQuery(
      config().HYDRA_ADMIN_URL,
      'admin/oauth2/auth/requests/logout/reject',
      'logout_challenge',
      challenge,
    ),
    { method: 'PUT' },
    [204],
  )
}
