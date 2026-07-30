import { createHash, randomUUID } from 'node:crypto'
import { authProductMarkerForAdmission } from './auth-brand'
import { config } from './config'
import { db } from './db'
import { fetchJson } from './http'
import { grantProductAdmission, hasProductAdmissionStrict } from './keto'

export type InvitationState =
  | 'pending_identity'
  | 'identity_failed'
  | 'pending_dispatch'
  | 'dispatch_failed'
  | 'dispatched'
  | 'activation_pending'
  | 'activation_failed'
  | 'active'
  | 'expired'

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

type DbInvitation = {
  id: string
  identity_id: string | null
  normalized_email: string
  product: string
  invited_by: string
  idempotency_key: string
  request_fingerprint: string
  state: InvitationState
  admission_preexisting: boolean
  expires_at: Date
  recovery_dispatched_at: Date | null
}

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
    identityId: row.identity_id,
    normalizedEmail: row.normalized_email,
    product: row.product,
    invitedBy: row.invited_by,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    state: row.state,
    admissionPreexisting: row.admission_preexisting,
    expiresAt: row.expires_at,
    recoveryDispatchedAt: row.recovery_dispatched_at,
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
  const inserted = await db()<DbInvitation[]>`
    insert into auth_control.invitations (
      id,
      normalized_email,
      product,
      invited_by,
      expires_at,
      idempotency_key,
      request_fingerprint,
      state
    )
    values (
      ${id}::uuid,
      ${input.email},
      ${input.product},
      ${input.invitedBy},
      now() + ${input.expiresInHours} * interval '1 hour',
      ${input.idempotencyKey},
      ${fingerprint},
      'pending_identity'
    )
    on conflict (idempotency_key) do nothing
    returning *
  `

  const row =
    inserted[0] ??
    (
      await db()<DbInvitation[]>`
        select *
        from auth_control.invitations
        where idempotency_key = ${input.idempotencyKey}
      `
    )[0]
  if (!row) throw new InvitationUnavailableError('Unable to reserve invitation')
  if (row.request_fingerprint !== fingerprint) {
    throw new InvitationConflictError('Idempotency key was used for a different invitation')
  }

  return { invitation: fromDb(row), created: inserted.length === 1 }
}

async function claimInvitation(invitation: Invitation): Promise<ClaimedInvitation | null> {
  await db()`
    update auth_control.invitations
    set state = 'expired',
        expired_at = now(),
        processing_token = null,
        processing_started_at = null,
        updated_at = now()
    where id = ${invitation.id}::uuid
      and state not in ('active', 'expired')
      and activation_requested_at is null
      and expires_at <= now()
  `

  const processingToken = randomUUID()
  const rows = await db()<DbInvitation[]>`
    update auth_control.invitations
    set processing_token = ${processingToken}::uuid,
        processing_started_at = now(),
        attempt_count = attempt_count + 1,
        updated_at = now()
    where id = ${invitation.id}::uuid
      and state in ('pending_identity', 'identity_failed', 'pending_dispatch', 'dispatch_failed')
      and expires_at > now()
      and (
        processing_token is null
        or processing_started_at < now() - interval '2 minutes'
      )
    returning *
  `
  return rows[0] ? { ...fromDb(rows[0]), processingToken } : null
}

async function attachIdentity(
  invitation: ClaimedInvitation,
  identityId: string,
  admissionPreexisting: boolean,
): Promise<ClaimedInvitation> {
  const rows = await db()<DbInvitation[]>`
    update auth_control.invitations
    set identity_id = ${identityId}::uuid,
        admission_preexisting = ${admissionPreexisting},
        state = 'pending_dispatch',
        last_error_code = null,
        updated_at = now()
    where id = ${invitation.id}::uuid
      and processing_token = ${invitation.processingToken}::uuid
    returning *
  `
  if (!rows[0]) throw new InvitationUnavailableError('Invitation processing lease was lost')
  return { ...fromDb(rows[0]), processingToken: invitation.processingToken }
}

async function markDispatched(invitation: ClaimedInvitation): Promise<Invitation> {
  const rows = await db()<DbInvitation[]>`
    update auth_control.invitations
    set state = 'dispatched',
        recovery_dispatched_at = now(),
        processing_token = null,
        processing_started_at = null,
        last_error_code = null,
        updated_at = now()
    where id = ${invitation.id}::uuid
      and processing_token = ${invitation.processingToken}::uuid
    returning *
  `
  if (!rows[0]) throw new InvitationUnavailableError('Invitation processing lease was lost')
  return fromDb(rows[0])
}

async function markInvitationFailure(
  invitation: ClaimedInvitation,
  state: 'identity_failed' | 'dispatch_failed',
  errorCode: string,
): Promise<void> {
  await db()`
    update auth_control.invitations
    set state = ${state},
        processing_token = null,
        processing_started_at = null,
        last_error_code = ${errorCode},
        updated_at = now()
    where id = ${invitation.id}::uuid
      and processing_token = ${invitation.processingToken}::uuid
  `
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
  return db().begin(async (transaction) => {
    await transaction`
      insert into auth_control.hook_receipts (
        event_id,
        hook_type,
        identity_id,
        flow_id
      )
      values (
        ${input.eventId},
        'invitation_recovery',
        ${input.identityId}::uuid,
        ${input.flowId}
      )
      on conflict (event_id) do nothing
    `

    await transaction`
      update auth_control.invitations
      set state = 'expired',
          expired_at = now(),
          updated_at = now()
      where identity_id = ${input.identityId}::uuid
        and state in ('dispatched', 'activation_pending', 'activation_failed')
        and activation_requested_at is null
        and expires_at <= now()
    `

    const candidates = await transaction<
      Array<{
        id: string
        identity_id: string
        product: string
        admission_preexisting: boolean
      }>
    >`
      select id, identity_id, product, admission_preexisting
      from auth_control.invitations
      where identity_id = ${input.identityId}::uuid
        and (
          (state = 'dispatched' and expires_at > now())
          or (
            state in ('activation_pending', 'activation_failed')
            and activation_requested_at is not null
            and (
              processing_token is null
              or processing_started_at < now() - interval '2 minutes'
            )
          )
        )
      for update
    `

    const claimed: ActivationCandidate[] = []
    for (const candidate of candidates) {
      const processingToken = randomUUID()
      await transaction`
        update auth_control.invitations
        set state = 'activation_pending',
            activation_requested_at = coalesce(activation_requested_at, now()),
            processing_token = ${processingToken}::uuid,
            processing_started_at = now(),
            attempt_count = attempt_count + 1,
            last_error_code = null,
            updated_at = now()
        where id = ${candidate.id}::uuid
      `
      await transaction`
        insert into auth_control.invitation_events (
          event_id,
          invitation_id,
          event_type,
          outcome,
          flow_id
        )
        values (
          ${input.eventId},
          ${candidate.id}::uuid,
          'recovery_activation',
          'pending',
          ${input.flowId}
        )
        on conflict (event_id, invitation_id) do update
        set outcome = 'pending',
            detail_code = null,
            updated_at = now()
      `
      claimed.push({
        id: candidate.id,
        identityId: candidate.identity_id,
        product: candidate.product,
        admissionPreexisting: candidate.admission_preexisting,
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
  await db().begin(async (transaction) => {
    const updated = await transaction`
      update auth_control.invitations
      set state = 'active',
          activated_at = now(),
          processing_token = null,
          processing_started_at = null,
          last_error_code = null,
          updated_at = now()
      where id = ${candidate.id}::uuid
        and state = 'activation_pending'
        and processing_token = ${candidate.processingToken}::uuid
      returning id
    `
    if (updated.length !== 1) throw new Error('Invitation activation lease was lost')
    await transaction`
      update auth_control.invitation_events
      set outcome = 'succeeded',
          detail_code = null,
          updated_at = now()
      where event_id = ${eventId}
        and invitation_id = ${candidate.id}::uuid
    `
  })
}

async function failInvitationActivation(
  eventId: string,
  candidate: ActivationCandidate,
): Promise<void> {
  await db().begin(async (transaction) => {
    await transaction`
      update auth_control.invitations
      set state = 'activation_failed',
          processing_token = null,
          processing_started_at = null,
          last_error_code = 'keto_admission_failed',
          updated_at = now()
      where id = ${candidate.id}::uuid
        and state = 'activation_pending'
        and processing_token = ${candidate.processingToken}::uuid
    `
    await transaction`
      update auth_control.invitation_events
      set outcome = 'failed',
          detail_code = 'keto_admission_failed',
          updated_at = now()
      where event_id = ${eventId}
        and invitation_id = ${candidate.id}::uuid
    `
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
  return db().begin(async (transaction) => {
    const candidates = await transaction<
      Array<{
        id: string
        identity_id: string
        product: string
        admission_preexisting: boolean
      }>
    >`
      select id, identity_id, product, admission_preexisting
      from auth_control.invitations
      where state in ('activation_pending', 'activation_failed')
        and activation_requested_at is not null
        and (
          processing_token is null
          or processing_started_at < now() - interval '2 minutes'
        )
      order by activation_requested_at, id
      limit ${limit}
      for update skip locked
    `

    const claimed: ReconciliationCandidate[] = []
    for (const candidate of candidates) {
      const eventId = `invitation_reconcile:${candidate.id}`
      const processingToken = randomUUID()
      await transaction`
        update auth_control.invitations
        set state = 'activation_pending',
            processing_token = ${processingToken}::uuid,
            processing_started_at = now(),
            attempt_count = attempt_count + 1,
            last_error_code = null,
            updated_at = now()
        where id = ${candidate.id}::uuid
      `
      await transaction`
        insert into auth_control.invitation_events (
          event_id,
          invitation_id,
          event_type,
          outcome
        )
        values (
          ${eventId},
          ${candidate.id}::uuid,
          'activation_reconcile',
          'pending'
        )
        on conflict (event_id, invitation_id) do update
        set outcome = 'pending',
            detail_code = null,
            updated_at = now()
      `
      claimed.push({
        eventId,
        candidate: {
          id: candidate.id,
          identityId: candidate.identity_id,
          product: candidate.product,
          admissionPreexisting: candidate.admission_preexisting,
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
  const rows = await db()<Array<{ blocked: boolean }>>`
    select exists (
      select 1
      from auth_control.invitations
      where identity_id = ${identityId}::uuid
        and product = ${product}
        and not admission_preexisting
        and state not in ('active', 'expired')
    ) as blocked
  `
  return rows[0]?.blocked ?? true
}
