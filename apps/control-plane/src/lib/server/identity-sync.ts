import { createHash } from 'node:crypto'
import { config } from './config'
import { db, setResetGate } from './db'
import { fetchJson } from './http'
import { grantProductAdmission, revokeProductAdmission, setTenantMembership } from './keto'

export type IdentitySyncMembership = {
  organizationId: string
  relation: 'members' | 'administrators'
}

export type IdentitySyncEntry = {
  sourceUserId: string
  email: string
  firstName?: string
  lastName?: string
  passwordHash?: string
  state: 'active' | 'revoked'
  memberships: IdentitySyncMembership[]
}

export type IdentitySyncRequest = {
  requestSha256: string
  clientId: string
  source: string
  compatibleSources: readonly string[]
  admissionScope: string
  sourceSnapshot: string
  identities: IdentitySyncEntry[]
}

export type IdentitySyncResult = {
  request_sha256: string
  source: string
  source_snapshot: string
  synchronized: number
  created: number
  linked: number
  revoked: number
  skipped: number
  identities: Array<{
    source_user_id: string
    identity_id: string
    state: 'active' | 'revoked'
  }>
}

type SourceAlias = {
  source: string
  source_user_id: string
  identity_id: string
  email_sha256: string
  admission_scope: string
  state: 'active' | 'revoked'
}

type KratosIdentity = {
  id: string
  external_id?: string
  state?: string
  traits?: { email?: string }
}

export class IdentitySyncError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code)
  }
}

function emailSha256(email: string): string {
  return createHash('sha256').update(email).digest('hex')
}

function externalId(source: string, sourceUserId: string): string {
  const value = `${source}:${sourceUserId}`
  if (value.length > 255) throw new IdentitySyncError('external_id_too_long', 400)
  return value
}

async function findIdentityByEmail(email: string): Promise<KratosIdentity | undefined> {
  const url = new URL('admin/identities', `${config().KRATOS_ADMIN_URL}/`)
  url.searchParams.set('credentials_identifier', email)
  const identities = await fetchJson<KratosIdentity[]>(url)
  if (identities.length > 1) throw new IdentitySyncError('ambiguous_identity', 409)
  return identities[0]
}

async function getIdentity(identityId: string): Promise<KratosIdentity> {
  return fetchJson<KratosIdentity>(
    new URL(`admin/identities/${encodeURIComponent(identityId)}`, `${config().KRATOS_ADMIN_URL}/`),
  )
}

async function createIdentity(input: {
  source: string
  sourceUserId: string
  email: string
  firstName?: string
  lastName?: string
  passwordHash: string
}): Promise<KratosIdentity> {
  return fetchJson<KratosIdentity>(
    new URL('admin/identities', `${config().KRATOS_ADMIN_URL}/`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_id: 'default',
        state: 'inactive',
        external_id: externalId(input.source, input.sourceUserId),
        traits: {
          email: input.email,
          name: {
            ...(input.firstName ? { first: input.firstName } : {}),
            ...(input.lastName ? { last: input.lastName } : {}),
          },
        },
        credentials: {
          password: {
            config: {
              hashed_password: input.passwordHash,
            },
          },
        },
        metadata_admin: {
          migration: {
            source: input.source,
            source_user_id: input.sourceUserId,
          },
        },
      }),
    },
    [201],
  )
}

async function activateIdentity(identityId: string): Promise<void> {
  await fetchJson(
    new URL(`admin/identities/${encodeURIComponent(identityId)}`, `${config().KRATOS_ADMIN_URL}/`),
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'replace', path: '/state', value: 'active' }]),
    },
    [200],
  )
}

async function currentAlias(
  source: string,
  sourceUserId: string,
): Promise<SourceAlias | undefined> {
  const rows = await db()<SourceAlias[]>`
    select source,
           source_user_id,
           identity_id::text,
           email_sha256,
           admission_scope,
           state
    from auth_control.identity_source_aliases
    where source = ${source}
      and source_user_id = ${sourceUserId}
  `
  return rows[0]
}

async function compatibleAlias(input: {
  sources: readonly string[]
  sourceUserId: string
  emailSha256: string
}): Promise<SourceAlias | undefined> {
  if (input.sources.length === 0) return undefined
  const rows = await db()<SourceAlias[]>`
    select source,
           source_user_id,
           identity_id::text,
           email_sha256,
           admission_scope,
           state
    from auth_control.identity_source_aliases
    where source in ${db()(input.sources)}
      and source_user_id = ${input.sourceUserId}
      and email_sha256 = ${input.emailSha256}
      and state = 'active'
  `
  if (new Set(rows.map((row) => row.identity_id)).size > 1) {
    throw new IdentitySyncError('counterpart_identity_collision', 409)
  }
  return rows[0]
}

async function persistAlias(input: {
  source: string
  sourceUserId: string
  identityId: string
  emailSha256: string
  admissionScope: string
  state: 'active' | 'revoked'
  snapshot: string
}): Promise<SourceAlias> {
  const rows = await db()<SourceAlias[]>`
    insert into auth_control.identity_source_aliases (
      source,
      source_user_id,
      identity_id,
      email_sha256,
      admission_scope,
      state,
      first_snapshot,
      last_snapshot
    )
    values (
      ${input.source},
      ${input.sourceUserId},
      ${input.identityId}::uuid,
      ${input.emailSha256},
      ${input.admissionScope},
      ${input.state},
      ${input.snapshot},
      ${input.snapshot}
    )
    on conflict (source, source_user_id) do update
    set state = excluded.state,
        last_snapshot = excluded.last_snapshot,
        updated_at = now()
    where auth_control.identity_source_aliases.identity_id = excluded.identity_id
      and auth_control.identity_source_aliases.email_sha256 = excluded.email_sha256
      and auth_control.identity_source_aliases.admission_scope = excluded.admission_scope
    returning source,
              source_user_id,
              identity_id::text,
              email_sha256,
              admission_scope,
              state
  `
  if (!rows[0]) throw new IdentitySyncError('source_identity_collision', 409)
  return rows[0]
}

async function existingMemberships(source: string, sourceUserId: string) {
  return db()<Array<{ organization_id: string; relation: 'members' | 'administrators' }>>`
    select organization_id::text, relation
    from auth_control.identity_source_memberships
    where source = ${source}
      and source_user_id = ${sourceUserId}
  `
}

async function replaceMembershipLedger(input: {
  source: string
  sourceUserId: string
  identityId: string
  admissionScope: string
  snapshot: string
  memberships: IdentitySyncMembership[]
}): Promise<void> {
  await db().begin(async (transaction) => {
    await transaction`
      delete from auth_control.identity_source_memberships
      where source = ${input.source}
        and source_user_id = ${input.sourceUserId}
    `
    for (const membership of input.memberships) {
      await transaction`
        insert into auth_control.identity_source_memberships (
          source,
          source_user_id,
          admission_scope,
          organization_id,
          identity_id,
          relation,
          last_snapshot
        )
        values (
          ${input.source},
          ${input.sourceUserId},
          ${input.admissionScope},
          ${membership.organizationId}::uuid,
          ${input.identityId}::uuid,
          ${membership.relation},
          ${input.snapshot}
        )
      `
    }
  })
}

async function synchronizeMemberships(input: {
  alias: SourceAlias
  snapshot: string
  desired: IdentitySyncMembership[]
}): Promise<void> {
  const previous = await existingMemberships(input.alias.source, input.alias.source_user_id)
  const desiredByOrganization = new Map(
    input.desired.map((membership) => [membership.organizationId, membership.relation]),
  )

  for (const membership of previous) {
    if (desiredByOrganization.get(membership.organization_id) === membership.relation) continue
    await setTenantMembership({
      identityId: input.alias.identity_id,
      organizationId: membership.organization_id,
      product: input.alias.admission_scope,
      relation: membership.relation,
      state: 'revoked',
    })
  }
  for (const membership of input.desired) {
    await setTenantMembership({
      identityId: input.alias.identity_id,
      organizationId: membership.organizationId,
      product: input.alias.admission_scope,
      relation: membership.relation,
      state: 'active',
    })
  }
  await replaceMembershipLedger({
    source: input.alias.source,
    sourceUserId: input.alias.source_user_id,
    identityId: input.alias.identity_id,
    admissionScope: input.alias.admission_scope,
    snapshot: input.snapshot,
    memberships: input.desired,
  })
}

async function hasAnotherActiveAdmission(alias: SourceAlias): Promise<boolean> {
  const rows = await db()<Array<{ found: boolean }>>`
    select exists (
      select 1
      from auth_control.identity_source_aliases
      where identity_id = ${alias.identity_id}::uuid
        and admission_scope = ${alias.admission_scope}
        and state = 'active'
        and (source, source_user_id) <> (${alias.source}, ${alias.source_user_id})
    ) as found
  `
  return rows[0]?.found === true
}

async function synchronizeEntry(
  request: IdentitySyncRequest,
  entry: IdentitySyncEntry,
): Promise<{ identityId?: string; created: boolean; linked: boolean; skipped: boolean }> {
  const normalizedEmail = entry.email.trim().toLowerCase()
  const digest = emailSha256(normalizedEmail)
  let alias = await currentAlias(request.source, entry.sourceUserId)
  let created = false
  let linked = false

  if (alias) {
    if (alias.email_sha256 !== digest || alias.admission_scope !== request.admissionScope) {
      throw new IdentitySyncError('source_identity_collision', 409)
    }
  } else {
    const counterpart = await compatibleAlias({
      sources: request.compatibleSources,
      sourceUserId: entry.sourceUserId,
      emailSha256: digest,
    })
    let identityId: string
    if (counterpart) {
      identityId = counterpart.identity_id
      linked = true
    } else {
      if (entry.state === 'revoked') {
        return { created: false, linked: false, skipped: true }
      }
      if (!entry.passwordHash) {
        throw new IdentitySyncError('active_identity_password_missing', 400)
      }
      const emailOwner = await findIdentityByEmail(normalizedEmail)
      if (emailOwner) throw new IdentitySyncError('email_owned_by_unrelated_identity', 409)
      const identity = await createIdentity({
        source: request.source,
        sourceUserId: entry.sourceUserId,
        email: normalizedEmail,
        ...(entry.firstName ? { firstName: entry.firstName } : {}),
        ...(entry.lastName ? { lastName: entry.lastName } : {}),
        passwordHash: entry.passwordHash,
      })
      identityId = identity.id
      created = true
    }
    alias = await persistAlias({
      source: request.source,
      sourceUserId: entry.sourceUserId,
      identityId,
      emailSha256: digest,
      admissionScope: request.admissionScope,
      state: entry.state,
      snapshot: request.sourceSnapshot,
    })
  }

  const identity = await getIdentity(alias.identity_id)
  if (identity.traits?.email?.trim().toLowerCase() !== normalizedEmail) {
    throw new IdentitySyncError('identity_email_mismatch', 409)
  }

  if (created || identity.state === 'inactive') {
    if (identity.external_id !== externalId(request.source, entry.sourceUserId)) {
      throw new IdentitySyncError('inactive_identity_not_owned_by_source', 409)
    }
    await setResetGate({ identityId: alias.identity_id, source: request.source })
    await activateIdentity(alias.identity_id)
  }

  alias = await persistAlias({
    source: request.source,
    sourceUserId: entry.sourceUserId,
    identityId: alias.identity_id,
    emailSha256: digest,
    admissionScope: request.admissionScope,
    state: entry.state,
    snapshot: request.sourceSnapshot,
  })

  if (entry.state === 'active') {
    await grantProductAdmission(alias.identity_id, request.admissionScope)
    await synchronizeMemberships({
      alias,
      snapshot: request.sourceSnapshot,
      desired: entry.memberships,
    })
  } else {
    await synchronizeMemberships({ alias, snapshot: request.sourceSnapshot, desired: [] })
    if (!(await hasAnotherActiveAdmission(alias))) {
      await revokeProductAdmission(alias.identity_id, request.admissionScope)
    }
  }

  return { identityId: alias.identity_id, created, linked, skipped: false }
}

export async function synchronizeIdentityBatch(
  request: IdentitySyncRequest,
): Promise<IdentitySyncResult> {
  const existing = await db()<Array<{ status: string; response: IdentitySyncResult | null }>>`
    insert into auth_control.identity_sync_batches (
      request_sha256,
      client_id,
      source,
      source_snapshot,
      expected_count,
      status
    )
    values (
      ${request.requestSha256},
      ${request.clientId},
      ${request.source},
      ${request.sourceSnapshot},
      ${request.identities.length},
      'running'
    )
    on conflict (request_sha256) do update
    set status = case
          when auth_control.identity_sync_batches.status = 'failed' then 'running'
          else auth_control.identity_sync_batches.status
        end,
        completed_at = case
          when auth_control.identity_sync_batches.status = 'failed' then null
          else auth_control.identity_sync_batches.completed_at
        end,
        last_error_code = case
          when auth_control.identity_sync_batches.status = 'failed' then null
          else auth_control.identity_sync_batches.last_error_code
        end
    where auth_control.identity_sync_batches.client_id = excluded.client_id
      and auth_control.identity_sync_batches.source = excluded.source
      and auth_control.identity_sync_batches.source_snapshot = excluded.source_snapshot
      and auth_control.identity_sync_batches.expected_count = excluded.expected_count
    returning status, response
  `
  const batch = existing[0]
  if (!batch) throw new IdentitySyncError('batch_hash_collision', 409)
  if (batch.status === 'completed' && batch.response) return batch.response

  let created = 0
  let linked = 0
  let revoked = 0
  let skipped = 0
  const identities: IdentitySyncResult['identities'] = []
  try {
    for (const entry of request.identities) {
      const result = await synchronizeEntry(request, entry)
      if (result.created) created += 1
      if (result.linked) linked += 1
      if (entry.state === 'revoked') revoked += 1
      if (result.skipped) {
        skipped += 1
        continue
      }
      if (!result.identityId) throw new IdentitySyncError('identity_sync_incomplete', 503)
      identities.push({
        source_user_id: entry.sourceUserId,
        identity_id: result.identityId,
        state: entry.state,
      })
    }
    const result: IdentitySyncResult = {
      request_sha256: request.requestSha256,
      source: request.source,
      source_snapshot: request.sourceSnapshot,
      synchronized: request.identities.length,
      created,
      linked,
      revoked,
      skipped,
      identities,
    }
    await db()`
      update auth_control.identity_sync_batches
      set status = 'completed',
          response = ${db().json(result)},
          completed_at = now(),
          last_error_code = null
      where request_sha256 = ${request.requestSha256}
    `
    return result
  } catch (caught) {
    const code = caught instanceof IdentitySyncError ? caught.code : 'identity_sync_unavailable'
    await db()`
      update auth_control.identity_sync_batches
      set status = 'failed',
          completed_at = null,
          last_error_code = ${code}
      where request_sha256 = ${request.requestSha256}
        and status <> 'completed'
    `.catch(() => undefined)
    throw caught
  }
}
