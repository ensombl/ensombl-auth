import { error } from '@sveltejs/kit'
import { config } from './config'
import { isResetRequired } from './db'
import { hasUnactivatedInvitationAdmission } from './invitations'
import { hasProductAdmission } from './keto'
import type { HydraClient, KratosSession } from './types'

export function productForClient(client: HydraClient): string {
  const mapped = config().clientProductMap.get(client.client_id)
  if (!mapped) error(403, 'This OAuth client is not assigned to an Ensombl product')

  const metadataProduct = client.metadata?.ensombl_product
  if (
    typeof metadataProduct === 'string' &&
    metadataProduct.length > 0 &&
    metadataProduct !== mapped
  ) {
    error(403, 'OAuth client product metadata conflicts with the configured assignment')
  }
  return mapped
}

export function admissionScopeForClient(client: HydraClient): string {
  const scope = config().admissionScopeByClient.get(client.client_id)
  if (!scope) error(403, 'This OAuth client has no configured admission scope')
  return scope
}

export async function evaluateAdmission(
  session: KratosSession,
  admissionScope: string,
): Promise<'allowed' | 'reset_required' | 'not_admitted'> {
  if (!session.active || session.identity.state === 'inactive') return 'not_admitted'
  if (await isResetRequired(session.identity.id)) return 'reset_required'
  if (await hasUnactivatedInvitationAdmission(session.identity.id, admissionScope)) {
    return 'not_admitted'
  }
  if (!(await hasProductAdmission(session.identity.id, admissionScope))) return 'not_admitted'
  return 'allowed'
}

export function identityClaims(session: KratosSession): Record<string, unknown> {
  const email = session.identity.traits.email
  const first = session.identity.traits.name?.first
  const last = session.identity.traits.name?.last
  const verified =
    email !== undefined &&
    session.identity.verifiable_addresses?.some(
      (address) => address.value.toLowerCase() === email.toLowerCase() && address.verified,
    )

  return {
    ...(email ? { email, email_verified: verified ?? false } : {}),
    ...(first ? { given_name: first } : {}),
    ...(last ? { family_name: last } : {}),
    ...(first || last ? { name: [first, last].filter(Boolean).join(' ') } : {}),
  }
}
