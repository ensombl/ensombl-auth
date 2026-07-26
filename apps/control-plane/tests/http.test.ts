import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJson } from '../src/lib/server/http'
import { rejectLogout } from '../src/lib/server/ory'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Ory HTTP responses', () => {
  it('logs only allowlisted identifiers for JSON errors', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              id: 'session_already_available',
              code: 'invalid_request',
              message: 'patrick@example.com has csrf_token=do-not-log',
            },
            csrf_token: 'do-not-log',
            request_url: 'https://auth.example/?email=patrick@example.com',
          }),
          {
            status: 400,
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'ory-request-123',
            },
          },
        ),
      ),
    )

    await expect(fetchJson('http://ory.test/request')).rejects.toBeDefined()
    expect(logger).toHaveBeenCalledWith('Ory request failed', {
      status: 400,
      requestId: 'ory-request-123',
      errorId: 'session_already_available',
      errorCode: 'invalid_request',
    })
    expect(JSON.stringify(logger.mock.calls)).not.toContain('patrick@example.com')
    expect(JSON.stringify(logger.mock.calls)).not.toContain('csrf_token')
    expect(JSON.stringify(logger.mock.calls)).not.toContain('do-not-log')
  })

  it('does not log non-JSON response bodies or unsafe request identifiers', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('upstream included password=do-not-log', {
          status: 503,
          headers: {
            'content-type': 'text/plain',
            'x-request-id': 'unsafe-request-id@example.com',
          },
        }),
      ),
    )

    await expect(fetchJson('http://ory.test/request')).rejects.toBeDefined()
    expect(logger).toHaveBeenCalledWith('Ory request failed', { status: 503 })
    expect(JSON.stringify(logger.mock.calls)).not.toContain('do-not-log')
  })

  it('treats Hydra logout rejection with a 204 response as success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(rejectLogout('logout-challenge')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(requestUrl.pathname).toBe('/admin/oauth2/auth/requests/logout/reject')
    expect(requestUrl.searchParams.get('logout_challenge')).toBe('logout-challenge')
    expect(requestInit.method).toBe('PUT')
  })
})
