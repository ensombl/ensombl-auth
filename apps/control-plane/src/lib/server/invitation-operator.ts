import { error } from '@sveltejs/kit'
import { isResetRequired } from './db'
import { hasProductAdministrationStrict } from './keto'
import { getKratosSession } from './ory'

type InvitationOperatorDependencies = {
  getKratosSession: typeof getKratosSession
  isResetRequired: typeof isResetRequired
  hasProductAdministrationStrict: typeof hasProductAdministrationStrict
}

export type InvitationOperatorAccess =
  | { state: 'authorized'; identityId: string }
  | { state: 'login_required' }
  | { state: 'password_reset_required' }
  | { state: 'product_administrator_required' }
  | { state: 'aal2_required' }

const dependencies: InvitationOperatorDependencies = {
  getKratosSession,
  isResetRequired,
  hasProductAdministrationStrict,
}

export function invitationFormOriginAllowed(origin: string | null, publicAuthUrl: string): boolean {
  return origin === new URL(publicAuthUrl).origin
}

export async function invitationOperatorAccess(
  cookie: string | null,
  product: string,
  overrides: InvitationOperatorDependencies = dependencies,
): Promise<InvitationOperatorAccess> {
  const session = await overrides.getKratosSession(cookie)
  if (!session?.active || session.identity.state === 'inactive') {
    return { state: 'login_required' }
  }
  if (await overrides.isResetRequired(session.identity.id)) {
    return { state: 'password_reset_required' }
  }
  if (!(await overrides.hasProductAdministrationStrict(session.identity.id, product))) {
    return { state: 'product_administrator_required' }
  }
  if (session.authenticator_assurance_level !== 'aal2') {
    return { state: 'aal2_required' }
  }
  return { state: 'authorized', identityId: session.identity.id }
}

export async function authorizeInvitationOperator(
  cookie: string | null,
  product: string,
  overrides: InvitationOperatorDependencies = dependencies,
): Promise<string> {
  const access = await invitationOperatorAccess(cookie, product, overrides)
  switch (access.state) {
    case 'authorized':
      return access.identityId
    case 'login_required':
      return error(403, 'An active Ensombl identity session is required')
    case 'password_reset_required':
      return error(403, 'Complete the required password reset before issuing invitations')
    case 'product_administrator_required':
      return error(403, 'Product administrator permission is required')
    case 'aal2_required':
      return error(403, 'AAL2 authentication is required to issue invitations')
  }
}
