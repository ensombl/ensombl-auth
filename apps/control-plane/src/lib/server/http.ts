import { error } from '@sveltejs/kit'

type OryErrorMetadata = {
  errorId?: string
  errorCode?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return undefined
  return /^[a-zA-Z0-9._:-]+$/.test(value) ? value : undefined
}

async function parseOryErrorMetadata(response: Response): Promise<OryErrorMetadata> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('json')) return {}

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return {}
  }
  if (!isRecord(body)) return {}

  const nestedError = isRecord(body.error) ? body.error : undefined
  const errorId = safeIdentifier(nestedError?.id) ?? safeIdentifier(body.id)
  const errorCode =
    safeIdentifier(nestedError?.code) ??
    safeIdentifier(body.code) ??
    safeIdentifier(typeof body.error === 'string' ? body.error : undefined)
  return {
    ...(errorId ? { errorId } : {}),
    ...(errorCode ? { errorCode } : {}),
  }
}

export async function fetchJson<T>(
  input: string | URL,
  init: RequestInit = {},
  expectedStatuses: readonly number[] = [200],
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      accept: 'application/json',
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(10_000),
  })

  if (!expectedStatuses.includes(response.status)) {
    const requestId = safeIdentifier(response.headers.get('x-request-id'))
    const metadata = await parseOryErrorMetadata(response)
    console.error('Ory request failed', {
      status: response.status,
      ...(requestId ? { requestId } : {}),
      ...(metadata.errorId ? { errorId: metadata.errorId } : {}),
      ...(metadata.errorCode ? { errorCode: metadata.errorCode } : {}),
    })
    error(response.status >= 500 ? 502 : response.status, 'Identity service rejected the request')
  }

  if (response.status === 204 || response.status === 205) return undefined as T
  return (await response.json()) as T
}
