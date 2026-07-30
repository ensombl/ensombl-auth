import { createHash } from 'node:crypto'
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { config } from './config'
import {
  identitySourceAliases,
  identitySourceMemberships,
  identitySyncBatches,
} from './database-schema'
import { db, setResetGate } from './db'
import { fetchJson } from './http'
import { grantProductAdmission, revokeProductAdmission, setTenantMembership } from './keto'

export type IdentitySyncMembership = {
  tenantId: string
  role: string
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
  sourceUserId: string
  identityId: string
  emailSha256: string
  admissionScope: string
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
  const rows = await db()
    .select({
      source: identitySourceAliases.source,
      sourceUserId: identitySourceAliases.sourceUserId,
      identityId: identitySourceAliases.identityId,
      emailSha256: identitySourceAliases.emailSha256,
      admissionScope: identitySourceAliases.admissionScope,
      state: identitySourceAliases.state,
    })
    .from(identitySourceAliases)
    .where(
      and(
        eq(identitySourceAliases.source, source),
        eq(identitySourceAliases.sourceUserId, sourceUserId),
      ),
    )
    .limit(1)
  return rows[0]
}

async function compatibleAlias(input: {
  sources: readonly string[]
  sourceUserId: string
  emailSha256: string
}): Promise<SourceAlias | undefined> {
  if (input.sources.length === 0) return undefined
  const rows = await db()
    .select({
      source: identitySourceAliases.source,
      sourceUserId: identitySourceAliases.sourceUserId,
      identityId: identitySourceAliases.identityId,
      emailSha256: identitySourceAliases.emailSha256,
      admissionScope: identitySourceAliases.admissionScope,
      state: identitySourceAliases.state,
    })
    .from(identitySourceAliases)
    .where(
      and(
        inArray(identitySourceAliases.source, [...input.sources]),
        eq(identitySourceAliases.sourceUserId, input.sourceUserId),
        eq(identitySourceAliases.emailSha256, input.emailSha256),
        eq(identitySourceAliases.state, 'active'),
      ),
    )
  if (new Set(rows.map((row) => row.identityId)).size > 1) {
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
  const rows = await db()
    .insert(identitySourceAliases)
    .values({
      source: input.source,
      sourceUserId: input.sourceUserId,
      identityId: input.identityId,
      emailSha256: input.emailSha256,
      admissionScope: input.admissionScope,
      state: input.state,
      firstSnapshot: input.snapshot,
      lastSnapshot: input.snapshot,
    })
    .onConflictDoUpdate({
      target: [identitySourceAliases.source, identitySourceAliases.sourceUserId],
      set: {
        state: input.state,
        lastSnapshot: input.snapshot,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${identitySourceAliases.identityId} = ${input.identityId}
        and ${identitySourceAliases.emailSha256} = ${input.emailSha256}
        and ${identitySourceAliases.admissionScope} = ${input.admissionScope}`,
    })
    .returning({
      source: identitySourceAliases.source,
      sourceUserId: identitySourceAliases.sourceUserId,
      identityId: identitySourceAliases.identityId,
      emailSha256: identitySourceAliases.emailSha256,
      admissionScope: identitySourceAliases.admissionScope,
      state: identitySourceAliases.state,
    })
  if (!rows[0]) throw new IdentitySyncError('source_identity_collision', 409)
  return rows[0]
}

async function existingMemberships(source: string, sourceUserId: string) {
  return db()
    .select({
      tenantId: identitySourceMemberships.tenantId,
      role: identitySourceMemberships.role,
    })
    .from(identitySourceMemberships)
    .where(
      and(
        eq(identitySourceMemberships.source, source),
        eq(identitySourceMemberships.sourceUserId, sourceUserId),
      ),
    )
}

async function replaceMembershipLedger(input: {
  source: string
  sourceUserId: string
  identityId: string
  admissionScope: string
  snapshot: string
  memberships: IdentitySyncMembership[]
}): Promise<void> {
  await db().transaction(async (transaction) => {
    await transaction
      .delete(identitySourceMemberships)
      .where(
        and(
          eq(identitySourceMemberships.source, input.source),
          eq(identitySourceMemberships.sourceUserId, input.sourceUserId),
        ),
      )
    if (input.memberships.length > 0) {
      await transaction.insert(identitySourceMemberships).values(
        input.memberships.map((membership) => ({
          source: input.source,
          sourceUserId: input.sourceUserId,
          admissionScope: input.admissionScope,
          tenantId: membership.tenantId,
          identityId: input.identityId,
          role: membership.role,
          lastSnapshot: input.snapshot,
        })),
      )
    }
  })
}

async function synchronizeMemberships(input: {
  alias: SourceAlias
  snapshot: string
  desired: IdentitySyncMembership[]
}): Promise<void> {
  const previous = await existingMemberships(input.alias.source, input.alias.sourceUserId)
  const desiredByTenant = new Map(
    input.desired.map((membership) => [membership.tenantId, membership.role]),
  )
  const rolePolicy = config().tenantRolePolicyByAdmissionScope.get(input.alias.admissionScope)
  if (!rolePolicy) throw new IdentitySyncError('tenant_role_policy_missing', 500)

  for (const membership of previous) {
    if (desiredByTenant.get(membership.tenantId) === membership.role) continue
    await setTenantMembership({
      identityId: input.alias.identityId,
      tenantId: membership.tenantId,
      product: input.alias.admissionScope,
      role: membership.role,
      rolePolicy,
      state: 'revoked',
    })
  }
  for (const membership of input.desired) {
    await setTenantMembership({
      identityId: input.alias.identityId,
      tenantId: membership.tenantId,
      product: input.alias.admissionScope,
      role: membership.role,
      rolePolicy,
      state: 'active',
    })
  }
  await replaceMembershipLedger({
    source: input.alias.source,
    sourceUserId: input.alias.sourceUserId,
    identityId: input.alias.identityId,
    admissionScope: input.alias.admissionScope,
    snapshot: input.snapshot,
    memberships: input.desired,
  })
}

async function hasAnotherActiveAdmission(alias: SourceAlias): Promise<boolean> {
  const rows = await db()
    .select({ source: identitySourceAliases.source })
    .from(identitySourceAliases)
    .where(
      and(
        eq(identitySourceAliases.identityId, alias.identityId),
        eq(identitySourceAliases.admissionScope, alias.admissionScope),
        eq(identitySourceAliases.state, 'active'),
        or(
          ne(identitySourceAliases.source, alias.source),
          ne(identitySourceAliases.sourceUserId, alias.sourceUserId),
        ),
      ),
    )
    .limit(1)
  return rows.length > 0
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
    if (alias.emailSha256 !== digest || alias.admissionScope !== request.admissionScope) {
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
      identityId = counterpart.identityId
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

  const identity = await getIdentity(alias.identityId)
  if (identity.traits?.email?.trim().toLowerCase() !== normalizedEmail) {
    throw new IdentitySyncError('identity_email_mismatch', 409)
  }

  if (created || identity.state === 'inactive') {
    if (identity.external_id !== externalId(request.source, entry.sourceUserId)) {
      throw new IdentitySyncError('inactive_identity_not_owned_by_source', 409)
    }
    await setResetGate({ identityId: alias.identityId, source: request.source })
    await activateIdentity(alias.identityId)
  }

  alias = await persistAlias({
    source: request.source,
    sourceUserId: entry.sourceUserId,
    identityId: alias.identityId,
    emailSha256: digest,
    admissionScope: request.admissionScope,
    state: entry.state,
    snapshot: request.sourceSnapshot,
  })

  if (entry.state === 'active') {
    await grantProductAdmission(alias.identityId, request.admissionScope)
    await synchronizeMemberships({
      alias,
      snapshot: request.sourceSnapshot,
      desired: entry.memberships,
    })
  } else {
    await synchronizeMemberships({ alias, snapshot: request.sourceSnapshot, desired: [] })
    if (!(await hasAnotherActiveAdmission(alias))) {
      await revokeProductAdmission(alias.identityId, request.admissionScope)
    }
  }

  return { identityId: alias.identityId, created, linked, skipped: false }
}

export async function synchronizeIdentityBatch(
  request: IdentitySyncRequest,
): Promise<IdentitySyncResult> {
  const existing = await db()
    .insert(identitySyncBatches)
    .values({
      requestSha256: request.requestSha256,
      clientId: request.clientId,
      source: request.source,
      sourceSnapshot: request.sourceSnapshot,
      expectedCount: request.identities.length,
      status: 'running',
    })
    .onConflictDoUpdate({
      target: identitySyncBatches.requestSha256,
      set: {
        status: sql`case
          when ${identitySyncBatches.status} = 'failed' then 'running'
          else ${identitySyncBatches.status}
        end`,
        completedAt: sql`case
          when ${identitySyncBatches.status} = 'failed' then null
          else ${identitySyncBatches.completedAt}
        end`,
        lastErrorCode: sql`case
          when ${identitySyncBatches.status} = 'failed' then null
          else ${identitySyncBatches.lastErrorCode}
        end`,
      },
      setWhere: sql`${identitySyncBatches.clientId} = ${request.clientId}
        and ${identitySyncBatches.source} = ${request.source}
        and ${identitySyncBatches.sourceSnapshot} = ${request.sourceSnapshot}
        and ${identitySyncBatches.expectedCount} = ${request.identities.length}`,
    })
    .returning({
      status: identitySyncBatches.status,
      response: identitySyncBatches.response,
    })
  const batch = existing[0]
  if (!batch) throw new IdentitySyncError('batch_hash_collision', 409)
  if (batch.status === 'completed' && batch.response) {
    return batch.response as unknown as IdentitySyncResult
  }

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
    await db()
      .update(identitySyncBatches)
      .set({
        status: 'completed',
        response: result as unknown as Record<string, unknown>,
        completedAt: sql`now()`,
        lastErrorCode: null,
      })
      .where(eq(identitySyncBatches.requestSha256, request.requestSha256))
    return result
  } catch (caught) {
    const code = caught instanceof IdentitySyncError ? caught.code : 'identity_sync_unavailable'
    await db()
      .update(identitySyncBatches)
      .set({
        status: 'failed',
        completedAt: null,
        lastErrorCode: code,
      })
      .where(
        and(
          eq(identitySyncBatches.requestSha256, request.requestSha256),
          ne(identitySyncBatches.status, 'completed'),
        ),
      )
      .catch(() => undefined)
    throw caught
  }
}
