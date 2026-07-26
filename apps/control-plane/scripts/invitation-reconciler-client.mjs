export function reconciliationConfig() {
  const internalUrl = process.env.CONTROL_PLANE_INTERNAL_URL
  const secret = process.env.INVITATION_RECONCILER_SECRET
  const limit = Number(process.env.RECONCILE_LIMIT ?? '100')

  if (!internalUrl) throw new Error('CONTROL_PLANE_INTERNAL_URL is required')
  if (!secret || secret.length < 24) throw new Error('INVITATION_RECONCILER_SECRET is required')
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('RECONCILE_LIMIT must be an integer between 1 and 500')
  }
  return { internalUrl, secret, limit }
}

export async function reconcileInvitations(configuration, signal) {
  const endpoint = new URL('internal/invitations/reconcile', `${configuration.internalUrl}/`)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${configuration.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ limit: configuration.limit }),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`Invitation reconciliation failed with status ${response.status}`)
  }

  const result = await response.json()
  if (
    typeof result !== 'object' ||
    result === null ||
    !('reconciled' in result) ||
    typeof result.reconciled !== 'number'
  ) {
    throw new Error('Invitation reconciliation returned an invalid response')
  }
  return result.reconciled
}
