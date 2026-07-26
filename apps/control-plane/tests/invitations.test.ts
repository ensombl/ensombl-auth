import { describe, expect, it, vi } from 'vitest'
import {
  type ActivateInvitationDependencies,
  activateInvitations,
  type Invitation,
  InvitationUnavailableError,
  type IssueInvitationDependencies,
  issueInvitation,
  type ReconcileInvitationDependencies,
  reconcileInvitationActivations,
} from '../src/lib/server/invitations'

const expiresAt = new Date('2030-01-01T00:00:00.000Z')

function invitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: '5d37e8ce-b12a-49a4-8f0f-3ce90d96a373',
    identityId: null,
    normalizedEmail: 'invitee@example.test',
    product: 'freightclaims',
    invitedBy: 'operator@example.test',
    idempotencyKey: 'invite-request-0001',
    requestFingerprint: 'a'.repeat(64),
    state: 'pending_identity',
    admissionPreexisting: false,
    expiresAt,
    recoveryDispatchedAt: null,
    ...overrides,
  }
}

function request() {
  return {
    email: 'invitee@example.test',
    product: 'freightclaims',
    invitedBy: 'operator@example.test',
    expiresInHours: 48,
    idempotencyKey: 'invite-request-0001',
  }
}

describe('invitation issuance', () => {
  it('persists and claims the invitation before external calls, without granting admission', async () => {
    const calls: string[] = []
    const reserved = invitation()
    const claimed = { ...reserved, processingToken: 'processing-token' }
    const attached = {
      ...claimed,
      identityId: 'bb86046e-c922-44a3-a85f-ba21042c2897',
      state: 'pending_dispatch' as const,
    }
    const dispatched = {
      ...attached,
      state: 'dispatched' as const,
      recoveryDispatchedAt: new Date('2026-07-26T00:00:00.000Z'),
    }
    const dependencies: IssueInvitationDependencies = {
      reserveInvitation: vi.fn(async () => {
        calls.push('persist')
        return { invitation: reserved, created: true }
      }),
      claimInvitation: vi.fn(async () => {
        calls.push('claim')
        return claimed
      }),
      findOrCreateIdentity: vi.fn(async () => {
        calls.push('identity')
        return { id: 'bb86046e-c922-44a3-a85f-ba21042c2897' }
      }),
      hasProductAdmissionStrict: vi.fn(async () => {
        calls.push('check-existing-admission')
        return false
      }),
      attachIdentity: vi.fn(async () => {
        calls.push('attach-identity')
        return attached
      }),
      dispatchRecovery: vi.fn(async () => {
        calls.push('dispatch')
      }),
      markDispatched: vi.fn(async () => {
        calls.push('mark-dispatched')
        return dispatched
      }),
      markInvitationFailure: vi.fn(async () => {}),
    }

    const result = await issueInvitation(request(), dependencies)

    expect(result.invitation.state).toBe('dispatched')
    expect(calls).toEqual([
      'persist',
      'claim',
      'identity',
      'check-existing-admission',
      'attach-identity',
      'dispatch',
      'mark-dispatched',
    ])
  })

  it('replays an already-dispatched idempotency key without another email', async () => {
    const dispatched = invitation({
      identityId: 'bb86046e-c922-44a3-a85f-ba21042c2897',
      state: 'dispatched',
      recoveryDispatchedAt: new Date('2026-07-26T00:00:00.000Z'),
    })
    const claimInvitation = vi.fn()
    const dispatchRecovery = vi.fn()
    const dependencies = {
      reserveInvitation: vi.fn(async () => ({ invitation: dispatched, created: false })),
      claimInvitation,
      dispatchRecovery,
    } as unknown as IssueInvitationDependencies

    const result = await issueInvitation(request(), dependencies)

    expect(result).toMatchObject({ created: false, processing: false })
    expect(claimInvitation).not.toHaveBeenCalled()
    expect(dispatchRecovery).not.toHaveBeenCalled()
  })

  it('audits a dispatch failure and can resume from the persisted identity', async () => {
    const failed = invitation({
      identityId: 'bb86046e-c922-44a3-a85f-ba21042c2897',
      state: 'dispatch_failed',
    })
    const claimed = { ...failed, processingToken: 'retry-token' }
    const markInvitationFailure = vi.fn(async () => {})
    const dispatchRecovery = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('courier unavailable'))
      .mockResolvedValueOnce()
    const dependencies = {
      reserveInvitation: vi.fn(async () => ({ invitation: failed, created: false })),
      claimInvitation: vi.fn(async () => claimed),
      dispatchRecovery,
      markInvitationFailure,
      markDispatched: vi.fn(async () => ({
        ...failed,
        state: 'dispatched' as const,
        recoveryDispatchedAt: new Date('2026-07-26T00:00:00.000Z'),
      })),
      findOrCreateIdentity: vi.fn(),
    } as unknown as IssueInvitationDependencies

    await expect(issueInvitation(request(), dependencies)).rejects.toBeInstanceOf(
      InvitationUnavailableError,
    )
    await expect(issueInvitation(request(), dependencies)).resolves.toMatchObject({
      invitation: { state: 'dispatched' },
    })

    expect(markInvitationFailure).toHaveBeenCalledWith(
      claimed,
      'dispatch_failed',
      'recovery_dispatch_failed',
    )
    expect(dependencies.findOrCreateIdentity).not.toHaveBeenCalled()
    expect(dispatchRecovery).toHaveBeenCalledTimes(2)
  })
})

describe('invitation activation', () => {
  const activation = {
    eventId: 'invitation_recovery:flow-id:identity-id',
    identityId: 'bb86046e-c922-44a3-a85f-ba21042c2897',
    flowId: 'recovery-flow-id',
  }
  const candidate = {
    id: '5d37e8ce-b12a-49a4-8f0f-3ce90d96a373',
    identityId: activation.identityId,
    product: 'freightclaims',
    admissionPreexisting: false,
    processingToken: 'activation-processing-token',
  }

  it('records a failed grant and succeeds when the same activation is retried', async () => {
    const grantProductAdmission = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('keto unavailable'))
      .mockResolvedValueOnce()
    const failInvitationActivation = vi.fn(async () => {})
    const completeInvitationActivation = vi.fn(async () => {})
    const dependencies: ActivateInvitationDependencies = {
      beginInvitationActivation: vi.fn(async () => [candidate]),
      grantProductAdmission,
      completeInvitationActivation,
      failInvitationActivation,
    }

    await expect(activateInvitations(activation, dependencies)).rejects.toBeInstanceOf(
      InvitationUnavailableError,
    )
    await expect(activateInvitations(activation, dependencies)).resolves.toBe(1)

    expect(failInvitationActivation).toHaveBeenCalledExactlyOnceWith(activation.eventId, candidate)
    expect(completeInvitationActivation).toHaveBeenCalledExactlyOnceWith(
      activation.eventId,
      candidate,
    )
  })

  it('does not rewrite a product relation that existed before the invitation', async () => {
    const grantProductAdmission = vi.fn()
    const candidateWithAdmission = { ...candidate, admissionPreexisting: true }
    const dependencies = {
      beginInvitationActivation: vi.fn(async () => [candidateWithAdmission]),
      grantProductAdmission,
      completeInvitationActivation: vi.fn(async () => {}),
      failInvitationActivation: vi.fn(async () => {}),
    } as ActivateInvitationDependencies

    await expect(activateInvitations(activation, dependencies)).resolves.toBe(1)
    expect(grantProductAdmission).not.toHaveBeenCalled()
  })

  it('durably reconciles a persisted activation without webhook redelivery', async () => {
    const completeInvitationActivation = vi.fn(async () => {})
    const dependencies: ReconcileInvitationDependencies = {
      claimInvitationReconciliations: vi.fn(async () => [
        {
          eventId: `invitation_reconcile:${candidate.id}`,
          candidate,
        },
      ]),
      grantProductAdmission: vi.fn(async () => {}),
      completeInvitationActivation,
      failInvitationActivation: vi.fn(async () => {}),
    }

    await expect(reconcileInvitationActivations(100, dependencies)).resolves.toBe(1)
    expect(completeInvitationActivation).toHaveBeenCalledExactlyOnceWith(
      `invitation_reconcile:${candidate.id}`,
      candidate,
    )
  })

  it('records reconciliation failures and exits unsuccessfully for a later retry', async () => {
    const failInvitationActivation = vi.fn(async () => {})
    const dependencies: ReconcileInvitationDependencies = {
      claimInvitationReconciliations: vi.fn(async () => [
        {
          eventId: `invitation_reconcile:${candidate.id}`,
          candidate,
        },
      ]),
      grantProductAdmission: vi.fn(async () => {
        throw new Error('keto unavailable')
      }),
      completeInvitationActivation: vi.fn(async () => {}),
      failInvitationActivation,
    }

    await expect(reconcileInvitationActivations(100, dependencies)).rejects.toBeInstanceOf(
      InvitationUnavailableError,
    )
    expect(failInvitationActivation).toHaveBeenCalledExactlyOnceWith(
      `invitation_reconcile:${candidate.id}`,
      candidate,
    )
  })
})
