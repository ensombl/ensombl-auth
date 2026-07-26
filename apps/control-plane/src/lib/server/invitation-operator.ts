import { error } from '@sveltejs/kit'
import { isResetRequired } from './db'
import { hasProductAdministrationStrict } from './keto'
import { getKratosSession } from './ory'

type InvitationOperatorDependencies = {
  getKratosSession: typeof getKratosSession
  isResetRequired: typeof isResetRequired
  hasProductAdministrationStrict: typeof hasProductAdministrationStrict
}

const dependencies: InvitationOperatorDependencies = {
  getKratosSession,
  isResetRequired,
  hasProductAdministrationStrict,
}

export function invitationFormOriginAllowed(origin: string | null, publicAuthUrl: string): boolean {
  return origin === new URL(publicAuthUrl).origin
}

export async function authorizeInvitationOperator(
  cookie: string | null,
  product: string,
  overrides: InvitationOperatorDependencies = dependencies,
): Promise<string> {
  const session = await overrides.getKratosSession(cookie)
  if (!session?.active || session.identity.state === 'inactive') {
    error(403, 'An active Ensombl identity session is required')
  }
  if (session.authenticator_assurance_level !== 'aal2') {
    error(403, 'AAL2 authentication is required to issue invitations')
  }
  if (await overrides.isResetRequired(session.identity.id)) {
    error(403, 'Complete the required password reset before issuing invitations')
  }
  if (!(await overrides.hasProductAdministrationStrict(session.identity.id, product))) {
    error(403, 'Product administrator permission is required')
  }
  return session.identity.id
}
