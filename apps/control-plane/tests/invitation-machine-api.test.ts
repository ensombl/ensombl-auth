import { afterEach, describe, expect, it, vi } from 'vitest'

const invitations = vi.hoisted(() => ({
  InvitationConflictError: class InvitationConflictError extends Error {},
  InvitationUnavailableError: class InvitationUnavailableError extends Error {},
  issueInvitation: vi.fn(),
}))

vi.mock('$lib/server/invitations', () => invitations)

import { resetConfigForTest } from '../src/lib/server/config'
import { POST } from '../src/routes/internal/invitations/+server'

const originalEnvironment = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnvironment }
  resetConfigForTest()
  vi.clearAllMocks()
})

describe('machine invitation audit actor', () => {
  it('ignores spoofed caller attribution and records the configured service actor', async () => {
    process.env.INVITATION_SERVICE_ACTOR = 'service:trusted-invitation-importer'
    resetConfigForTest()
    invitations.issueInvitation.mockResolvedValue({
      created: true,
      processing: false,
      invitation: {
        id: '5d37e8ce-b12a-49a4-8f0f-3ce90d96a373',
        identityId: null,
        normalizedEmail: 'invitee@example.test',
        product: 'freightclaims',
        invitedBy: 'service:trusted-invitation-importer',
        idempotencyKey: 'machine-invite-request-0001',
        requestFingerprint: 'a'.repeat(64),
        state: 'dispatched',
        admissionPreexisting: false,
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        recoveryDispatchedAt: new Date('2026-07-26T00:00:00.000Z'),
      },
    })
    const request = new Request('http://control-plane/internal/invitations', {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-only-invitation-api-secret',
        'content-type': 'application/json',
        'idempotency-key': 'machine-invite-request-0001',
      },
      body: JSON.stringify({
        email: 'invitee@example.test',
        product: 'freightclaims',
        invited_by: 'attacker-controlled-audit-value',
        expires_in_hours: 48,
      }),
    })

    const response = await POST({ request } as Parameters<typeof POST>[0])

    expect(response.status).toBe(201)
    expect(invitations.issueInvitation).toHaveBeenCalledExactlyOnceWith({
      email: 'invitee@example.test',
      product: 'freightclaims',
      invitedBy: 'service:trusted-invitation-importer',
      expiresInHours: 48,
      idempotencyKey: 'machine-invite-request-0001',
    })
  })
})
