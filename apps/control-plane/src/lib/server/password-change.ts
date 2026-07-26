import { clearResetGateFromHook, isResetRequired } from './db'
import { revokeIdentitySessions } from './ory'

export type PasswordChangeHook = {
  eventId: string
  identityId: string
  flowId: string
  sessionId?: string
}

type PasswordChangeDependencies = {
  isResetRequired: typeof isResetRequired
  revokeIdentitySessions: typeof revokeIdentitySessions
  clearResetGateFromHook: typeof clearResetGateFromHook
}

const dependencies: PasswordChangeDependencies = {
  isResetRequired,
  revokeIdentitySessions,
  clearResetGateFromHook,
}

export async function completePasswordChange(
  input: PasswordChangeHook,
  overrides: PasswordChangeDependencies = dependencies,
): Promise<void> {
  if (!(await overrides.isResetRequired(input.identityId))) return
  await overrides.revokeIdentitySessions(input.identityId)
  await overrides.clearResetGateFromHook(input)
}
