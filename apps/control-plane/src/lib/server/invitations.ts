import { createHash, randomUUID } from 'node:crypto'
import { and, asc, eq, gt, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm'
import { authProductMarkerForAdmission } from './auth-brand'
import { config } from './config'
import {
  type InvitationState as DatabaseInvitationState,
  hookReceipts,
  invitationEvents,
  invitations,
} from './database-schema'
import { db } from './db'
import { fetchJson } from './http'
import { grantProductAdmission, hasProductAdmissionStrict } from './keto'

export type InvitationState = DatabaseInvitationState

export type Invitation = {
  id: string
  identityId: string | null
  normalizedEmail: string
  product: string
  invitedBy: string
  idempotencyKey: string
  requestFingerprint: string
  state: InvitationState
  admissionPreexisting: boolean
  expiresAt: Date
  recoveryDispatchedAt: Date | null
}

export type InvitationRequest = {
  email: string
  product: string
  invitedBy: string
  expiresInHours: number
  idempotencyKey: string
}

type DbInvitation = typeof invitations.$inferSelect

type ClaimedInvitation = Invitation & {
  processingToken: string
}

type Identity = {
  id: string
}

type RecoveryFlow = {
  id: string
}

export class InvitationConflictError extends Error {}
export class InvitationUnavailableError extends Error {}

function fromDb(row: DbInvitation): Invitation {
  return {
    id: row.id,
    identityId: row.identityId,
    normalizedEmail: row.normalizedEmail,
    product: row.product,
    invitedBy: row.invitedBy,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    state: row.state,
    admissionPreexisting: row.admissionPreexisting,
    expiresAt: row.expiresAt,
    recoveryDispatchedAt: row.recoveryDispatchedAt,
  }
}

export function invitationFingerprint(input: Omit<InvitationRequest, 'idempotencyKey'>): string {
  return createHash('sha256')
    .update(JSON.stringify([input.email, input.product, input.invitedBy, input.expiresInHours]))
    .digest('hex')
}

async function reserveInvitation(
  input: InvitationRequest,
): Promise<{ invitation: Invitation; created: boolean }> {
  const id = randomUUID()
  const fingerprint = invitationFingerprint(input)
  const inserted = await db()
    .insert(invitations)
    .values({
      id,
      normalizedEmail: input.email,
      product: input.product,
      invitedBy: input.invitedBy,
      expiresAt: sql`now() + ${input.expiresInHours} * interval '1 hour'`,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      state: 'pending_identity',
    })
    .onConflictDoNothing({ target: invitations.idempotencyKey })
    .returning()

  const row =
    inserted[0] ??
    (
      await db()
        .select()
        .from(invitations)
        .where(eq(invitations.idempotencyKey, input.idempotencyKey))
        .limit(1)
    )[0]
  if (!row) throw new InvitationUnavailableError('Unable to reserve invitation')
  if (row.requestFingerprint !== fingerprint) {
    throw new InvitationConflictError('Idempotency key was used for a different invitation')
  }

  return { invitation: fromDb(row), created: inserted.length === 1 }
}

async function claimInvitation(invitation: Invitation): Promise<ClaimedInvitation | null> {
  await db()
    .update(invitations)
    .set({
      state: 'expired',
      expiredAt: sql`now()`,
      processingToken: null,
      processingStartedAt: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(invitations.id, invitation.id),
        notInArray(invitations.state, ['active', 'expired']),
        isNull(invitations.activationRequestedAt),
        lte(invitations.expiresAt, sql`now()`),
      ),
    )

  const processingToken = randomUUID()
  const rows = await db()
    .update(invitations)
    .set({
      processingToken,
      processingStartedAt: sql`now()`,
      attemptCount: sql`${invitations.attemptCount} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(invitations.id, invitation.id),
        inArray(invitations.state, [
          'pending_identity',
          'identity_failed',
          'pending_dispatch',
          'dispatch_failed',
        ]),
        gt(invitations.expiresAt, sql`now()`),
        or(
          isNull(invitations.processingToken),
          lt(invitations.processingStartedAt, sql`now() - interval '2 minutes'`),
        ),
      ),
    )
    .returning()
  return rows[0] ? { ...fromDb(rows[0]), processingToken } : null
}

async function attachIdentity(
  invitation: ClaimedInvitation,
  identityId: string,
  admissionPreexisting: boolean,
): Promise<ClaimedInvitation> {
  const rows = await db()
    .update(invitations)
    .set({
      identityId,
      admissionPreexisting,
      state: 'pending_dispatch',
      lastErrorCode: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(invitations.id, invitation.id),
        eq(invitations.processingToken, invitation.processingToken),
      ),
    )
    .returning()
  if (!rows[0]) throw new InvitationUnavailableError('Invitation processing lease was lost')
  return { ...fromDb(rows[0]), processingToken: invitation.processingToken }
}

async function markDispatched(invitation: ClaimedInvitation): Promise<Invitation> {
  const rows = await db()
    .update(invitations)
    .set({
      state: 'dispatched',
      recoveryDispatchedAt: sql`now()`,
      processingToken: null,
      processingStartedAt: null,
      lastErrorCode: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(invitations.id, invitation.id),
        eq(invitations.processingToken, invitation.processingToken),
      ),
    )
    .returning()
  if (!rows[0]) throw new InvitationUnavailableError('Invitation processing lease was lost')
  return fromDb(rows[0])
}

async function markInvitationFailure(
  invitation: ClaimedInvitation,
  state: 'identity_failed' | 'dispatch_failed',
  errorCode: string,
): Promise<void> {
  await db()
    .update(invitations)
    .set({
      state,
      processingToken: null,
      processingStartedAt: null,
      lastErrorCode: errorCode,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(invitations.id, invitation.id),
        eq(invitations.processingToken, invitation.processingToken),
      ),
    )
}

async function findOrCreateIdentity(email: string): Promise<Identity> {
  const lookup = new URL('admin/identities', `${config().KRATOS_ADMIN_URL}/`)
  lookup.searchParams.set('credentials_identifier', email)
  const identities = await fetchJson<Identity[]>(lookup)
  if (identities.length > 1) throw new Error('ambiguous_identity')
  if (identities[0]) return identities[0]

  return fetchJson<Identity>(
    new URL('admin/identities', `${config().KRATOS_ADMIN_URL}/`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_id: 'default',
        state: 'active',
        traits: { email },
      }),
    },
    [201],
  )
}

async function dispatchRecovery(email: string, product: string): Promise<void> {
  const authProduct = authProductMarkerForAdmission(product)
  const flow = await fetchJson<RecoveryFlow>(
    new URL('self-service/recovery/api', `${config().KRATOS_PUBLIC_INTERNAL_URL}/`),
    { method: 'GET' },
  )
  const submit = new URL('self-service/recovery', `${config().KRATOS_PUBLIC_INTERNAL_URL}/`)
  submit.searchParams.set('flow', flow.id)
  await fetchJson(
    submit,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ensombl-auth-product': authProduct,
      },
      body: JSON.stringify({ method: 'code', email }),
    },
    [200],
  )
}

export type IssueInvitationDependencies = {
  reserveInvitation: typeof reserveInvitation
  claimInvitation: typeof claimInvitation
  attachIdentity: typeof attachIdentity
  markDispatched: typeof markDispatched
  markInvitationFailure: typeof markInvitationFailure
  findOrCreateIdentity: typeof findOrCreateIdentity
  hasProductAdmissionStrict: typeof hasProductAdmissionStrict
  dispatchRecovery: typeof dispatchRecovery
}

const issueDependencies: IssueInvitationDependencies = {
  reserveInvitation,
  claimInvitation,
  attachIdentity,
  markDispatched,
  markInvitationFailure,
  findOrCreateIdentity,
  hasProductAdmissionStrict,
  dispatchRecovery,
}

export async function issueInvitation(
  input: InvitationRequest,
  dependencies: IssueInvitationDependencies = issueDependencies,
): Promise<{ invitation: Invitation; created: boolean; processing: boolean }> {
  const reserved = await dependencies.reserveInvitation(input)
  if (
    ['dispatched', 'activation_pending', 'activation_failed', 'active', 'expired'].includes(
      reserved.invitation.state,
    )
  ) {
    return { ...reserved, processing: false }
  }

  let claimed = await dependencies.claimInvitation(reserved.invitation)
  if (!claimed) return { ...reserved, processing: true }

  if (!claimed.identityId) {
    try {
      const identity = await dependencies.findOrCreateIdentity(claimed.normalizedEmail)
      const admissionPreexisting = await dependencies.hasProductAdmissionStrict(
        identity.id,
        claimed.product,
      )
      claimed = await dependencies.attachIdentity(claimed, identity.id, admissionPreexisting)
    } catch {
      await dependencies
        .markInvitationFailure(claimed, 'identity_failed', 'identity_resolution_failed')
        .catch(() => {})
      throw new InvitationUnavailableError('Unable to resolve the invited identity')
    }
  }

  try {
    await dependencies.dispatchRecovery(claimed.normalizedEmail, claimed.product)
    return {
      invitation: await dependencies.markDispatched(claimed),
      created: reserved.created,
      processing: false,
    }
  } catch {
    await dependencies
      .markInvitationFailure(claimed, 'dispatch_failed', 'recovery_dispatch_failed')
      .catch(() => {})
    throw new InvitationUnavailableError('Unable to dispatch invitation recovery')
  }
}

type ActivationCandidate = {
  id: string
  identityId: string
  product: string
  admissionPreexisting: boolean
  processingToken: string
}

export type InvitationActivation = {
  eventId: string
  identityId: string
  flowId: string
}

async function beginInvitationActivation(
  input: InvitationActivation,
): Promise<ActivationCandidate[]> {
  return db().transaction(async (transaction) => {
    await transaction
      .insert(hookReceipts)
      .values({
        eventId: input.eventId,
        hookType: 'invitation_recovery',
        identityId: input.identityId,
        flowId: input.flowId,
      })
      .onConflictDoNothing({ target: hookReceipts.eventId })

    await transaction
      .update(invitations)
      .set({
        state: 'expired',
        expiredAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(invitations.identityId, input.identityId),
          inArray(invitations.state, ['dispatched', 'activation_pending', 'activation_failed']),
          isNull(invitations.activationRequestedAt),
          lte(invitations.expiresAt, sql`now()`),
        ),
      )

    const candidates = await transaction
      .select({
        id: invitations.id,
        identityId: invitations.identityId,
        product: invitations.product,
        admissionPreexisting: invitations.admissionPreexisting,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.identityId, input.identityId),
          or(
            and(eq(invitations.state, 'dispatched'), gt(invitations.expiresAt, sql`now()`)),
            and(
              inArray(invitations.state, ['activation_pending', 'activation_failed']),
              sql`${invitations.activationRequestedAt} is not null`,
              or(
                isNull(invitations.processingToken),
                lt(invitations.processingStartedAt, sql`now() - interval '2 minutes'`),
              ),
            ),
          ),
        ),
      )
      .for('update')

    const claimed: ActivationCandidate[] = []
    for (const candidate of candidates) {
      if (!candidate.identityId) {
        throw new Error('Activation candidate is missing its identity')
      }
      const processingToken = randomUUID()
      await transaction
        .update(invitations)
        .set({
          state: 'activation_pending',
          activationRequestedAt: sql`coalesce(${invitations.activationRequestedAt}, now())`,
          processingToken,
          processingStartedAt: sql`now()`,
          attemptCount: sql`${invitations.attemptCount} + 1`,
          lastErrorCode: null,
          updatedAt: sql`now()`,
        })
        .where(eq(invitations.id, candidate.id))
      await transaction
        .insert(invitationEvents)
        .values({
          eventId: input.eventId,
          invitationId: candidate.id,
          eventType: 'recovery_activation',
          outcome: 'pending',
          flowId: input.flowId,
        })
        .onConflictDoUpdate({
          target: [invitationEvents.eventId, invitationEvents.invitationId],
          set: {
            outcome: 'pending',
            detailCode: null,
            updatedAt: sql`now()`,
          },
        })
      claimed.push({
        id: candidate.id,
        identityId: candidate.identityId,
        product: candidate.product,
        admissionPreexisting: candidate.admissionPreexisting,
        processingToken,
      })
    }

    return claimed
  })
}

async function completeInvitationActivation(
  eventId: string,
  candidate: ActivationCandidate,
): Promise<void> {
  await db().transaction(async (transaction) => {
    const updated = await transaction
      .update(invitations)
      .set({
        state: 'active',
        activatedAt: sql`now()`,
        processingToken: null,
        processingStartedAt: null,
        lastErrorCode: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(invitations.id, candidate.id),
          eq(invitations.state, 'activation_pending'),
          eq(invitations.processingToken, candidate.processingToken),
        ),
      )
      .returning({ id: invitations.id })
    if (updated.length !== 1) throw new Error('Invitation activation lease was lost')
    await transaction
      .update(invitationEvents)
      .set({
        outcome: 'succeeded',
        detailCode: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(invitationEvents.eventId, eventId), eq(invitationEvents.invitationId, candidate.id)),
      )
  })
}

async function failInvitationActivation(
  eventId: string,
  candidate: ActivationCandidate,
): Promise<void> {
  await db().transaction(async (transaction) => {
    await transaction
      .update(invitations)
      .set({
        state: 'activation_failed',
        processingToken: null,
        processingStartedAt: null,
        lastErrorCode: 'keto_admission_failed',
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(invitations.id, candidate.id),
          eq(invitations.state, 'activation_pending'),
          eq(invitations.processingToken, candidate.processingToken),
        ),
      )
    await transaction
      .update(invitationEvents)
      .set({
        outcome: 'failed',
        detailCode: 'keto_admission_failed',
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(invitationEvents.eventId, eventId), eq(invitationEvents.invitationId, candidate.id)),
      )
  })
}

export type ActivateInvitationDependencies = {
  beginInvitationActivation: typeof beginInvitationActivation
  grantProductAdmission: typeof grantProductAdmission
  completeInvitationActivation: typeof completeInvitationActivation
  failInvitationActivation: typeof failInvitationActivation
}

const activationDependencies: ActivateInvitationDependencies = {
  beginInvitationActivation,
  grantProductAdmission,
  completeInvitationActivation,
  failInvitationActivation,
}

export async function activateInvitations(
  input: InvitationActivation,
  dependencies: ActivateInvitationDependencies = activationDependencies,
): Promise<number> {
  const candidates = await dependencies.beginInvitationActivation(input)
  for (const candidate of candidates) {
    try {
      if (!candidate.admissionPreexisting) {
        await dependencies.grantProductAdmission(candidate.identityId, candidate.product)
      }
      await dependencies.completeInvitationActivation(input.eventId, candidate)
    } catch {
      await dependencies.failInvitationActivation(input.eventId, candidate).catch(() => {})
      throw new InvitationUnavailableError('Unable to activate invitation admission')
    }
  }
  return candidates.length
}

type ReconciliationCandidate = {
  eventId: string
  candidate: ActivationCandidate
}

async function claimInvitationReconciliations(limit: number): Promise<ReconciliationCandidate[]> {
  return db().transaction(async (transaction) => {
    const candidates = await transaction
      .select({
        id: invitations.id,
        identityId: invitations.identityId,
        product: invitations.product,
        admissionPreexisting: invitations.admissionPreexisting,
      })
      .from(invitations)
      .where(
        and(
          inArray(invitations.state, ['activation_pending', 'activation_failed']),
          sql`${invitations.activationRequestedAt} is not null`,
          or(
            isNull(invitations.processingToken),
            lt(invitations.processingStartedAt, sql`now() - interval '2 minutes'`),
          ),
        ),
      )
      .orderBy(asc(invitations.activationRequestedAt), asc(invitations.id))
      .limit(limit)
      .for('update', { skipLocked: true })

    const claimed: ReconciliationCandidate[] = []
    for (const candidate of candidates) {
      if (!candidate.identityId) {
        throw new Error('Activation candidate is missing its identity')
      }
      const eventId = `invitation_reconcile:${candidate.id}`
      const processingToken = randomUUID()
      await transaction
        .update(invitations)
        .set({
          state: 'activation_pending',
          processingToken,
          processingStartedAt: sql`now()`,
          attemptCount: sql`${invitations.attemptCount} + 1`,
          lastErrorCode: null,
          updatedAt: sql`now()`,
        })
        .where(eq(invitations.id, candidate.id))
      await transaction
        .insert(invitationEvents)
        .values({
          eventId,
          invitationId: candidate.id,
          eventType: 'activation_reconcile',
          outcome: 'pending',
        })
        .onConflictDoUpdate({
          target: [invitationEvents.eventId, invitationEvents.invitationId],
          set: {
            outcome: 'pending',
            detailCode: null,
            updatedAt: sql`now()`,
          },
        })
      claimed.push({
        eventId,
        candidate: {
          id: candidate.id,
          identityId: candidate.identityId,
          product: candidate.product,
          admissionPreexisting: candidate.admissionPreexisting,
          processingToken,
        },
      })
    }
    return claimed
  })
}

export type ReconcileInvitationDependencies = {
  claimInvitationReconciliations: typeof claimInvitationReconciliations
  grantProductAdmission: typeof grantProductAdmission
  completeInvitationActivation: typeof completeInvitationActivation
  failInvitationActivation: typeof failInvitationActivation
}

const reconciliationDependencies: ReconcileInvitationDependencies = {
  claimInvitationReconciliations,
  grantProductAdmission,
  completeInvitationActivation,
  failInvitationActivation,
}

export async function reconcileInvitationActivations(
  limit = 100,
  dependencies: ReconcileInvitationDependencies = reconciliationDependencies,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('Reconciliation limit must be an integer between 1 and 500')
  }

  const claimed = await dependencies.claimInvitationReconciliations(limit)
  let failures = 0
  for (const { eventId, candidate } of claimed) {
    try {
      if (!candidate.admissionPreexisting) {
        await dependencies.grantProductAdmission(candidate.identityId, candidate.product)
      }
      await dependencies.completeInvitationActivation(eventId, candidate)
    } catch {
      failures += 1
      await dependencies.failInvitationActivation(eventId, candidate).catch(() => {})
    }
  }
  if (failures > 0) {
    throw new InvitationUnavailableError(
      `Unable to reconcile ${failures} invitation activation${failures === 1 ? '' : 's'}`,
    )
  }
  return claimed.length
}

export async function hasUnactivatedInvitationAdmission(
  identityId: string,
  product: string,
): Promise<boolean> {
  const rows = await db()
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.identityId, identityId),
        eq(invitations.product, product),
        eq(invitations.admissionPreexisting, false),
        notInArray(invitations.state, ['active', 'expired']),
      ),
    )
    .limit(1)
  return rows.length > 0
}
