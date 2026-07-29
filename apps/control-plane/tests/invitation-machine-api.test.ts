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
  it('derives the product and audit actor from the authenticated client', async () => {
    resetConfigForTest()
    invitations.issueInvitation.mockResolvedValue({
      created: true,
      processing: false,
      invitation: {
        id: '5d37e8ce-b12a-49a4-8f0f-3ce90d96a373',
        identityId: null,
        normalizedEmail: 'invitee@example.test',
        product: 'freightclaims',
        invitedBy: 'service:freightclaims-local-web',
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
        authorization: 'Bearer local-only-freightclaims-local-web-identity-management-secret',
        'content-type': 'application/json',
        'idempotency-key': 'machine-invite-request-0001',
      },
      body: JSON.stringify({
        client_id: 'freightclaims-local-web',
        email: 'invitee@example.test',
        expires_in_hours: 48,
      }),
    })

    const response = await POST({ request } as Parameters<typeof POST>[0])

    expect(response.status).toBe(201)
    expect(invitations.issueInvitation).toHaveBeenCalledExactlyOnceWith({
      email: 'invitee@example.test',
      product: 'freightclaims',
      invitedBy: 'service:freightclaims-local-web',
      expiresInHours: 48,
      idempotencyKey: 'machine-invite-request-0001',
    })
  })

  it('rejects caller-supplied attribution', async () => {
    const request = new Request('http://control-plane/internal/invitations', {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-only-freightclaims-local-web-identity-management-secret',
        'content-type': 'application/json',
        'idempotency-key': 'machine-invite-request-0002',
      },
      body: JSON.stringify({
        client_id: 'freightclaims-local-web',
        email: 'invitee@example.test',
        invited_by: 'attacker-controlled-audit-value',
      }),
    })

    const response = await POST({ request } as Parameters<typeof POST>[0])

    expect(response.status).toBe(400)
    expect(invitations.issueInvitation).not.toHaveBeenCalled()
  })
})
