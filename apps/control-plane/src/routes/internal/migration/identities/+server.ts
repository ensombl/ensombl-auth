import { createHash } from 'node:crypto'
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { config } from '$lib/server/config'
import { IdentitySyncError, synchronizeIdentityBatch } from '$lib/server/identity-sync'
import { hasBearer } from '$lib/server/internal-auth'
import type { RequestHandler } from './$types'

const membershipSchema = z
  .object({
    tenant_id: z.string().trim().min(1).max(200),
    role: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  })
  .strict()

const identitySchema = z
  .object({
    source_user_id: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:-]+$/),
    email: z
      .string()
      .email()
      .max(320)
      .transform((value) => value.trim().toLowerCase()),
    first_name: z.string().max(100).optional(),
    last_name: z.string().max(100).optional(),
    password_hash: z
      .string()
      .regex(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/)
      .optional(),
    state: z.enum(['active', 'revoked']),
    memberships: z.array(membershipSchema).max(100),
  })
  .strict()
  .superRefine((identity, context) => {
    if (identity.state === 'active' && identity.password_hash === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['password_hash'],
        message: 'Active identities require a migrated password hash',
      })
    }
  })

const bodySchema = z
  .object({
    client_id: z.string().regex(/^[A-Za-z0-9._-]+$/),
    source_snapshot: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:+-]+$/),
    identities: z.array(identitySchema).min(1).max(100),
  })
  .strict()
  .superRefine((body, context) => {
    const sourceUsers = new Set<string>()
    const emails = new Set<string>()
    for (const [index, identity] of body.identities.entries()) {
      if (sourceUsers.has(identity.source_user_id)) {
        context.addIssue({
          code: 'custom',
          path: ['identities', index, 'source_user_id'],
          message: 'Duplicate source identity',
        })
      }
      if (emails.has(identity.email)) {
        context.addIssue({
          code: 'custom',
          path: ['identities', index, 'email'],
          message: 'Duplicate email',
        })
      }
      sourceUsers.add(identity.source_user_id)
      emails.add(identity.email)
      const tenants = new Set<string>()
      for (const [membershipIndex, membership] of identity.memberships.entries()) {
        if (tenants.has(membership.tenant_id)) {
          context.addIssue({
            code: 'custom',
            path: ['identities', index, 'memberships', membershipIndex, 'tenant_id'],
            message: 'Duplicate tenant membership',
          })
        }
        tenants.add(membership.tenant_id)
      }
    }
  })

export const PUT: RequestHandler = async ({ request }) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, { status: 400 })

  const current = config()
  const expectedSecret = current.identityMigrationSecrets.get(parsed.data.client_id)
  const source = current.identityMigrationSourceByClient.get(parsed.data.client_id)
  const admissionScope = current.admissionScopeByClient.get(parsed.data.client_id)
  const product = current.clientProductMap.get(parsed.data.client_id)
  const rolePolicy = current.tenantRolePolicyByProduct.get(product ?? '')
  if (
    !expectedSecret ||
    !source ||
    !admissionScope ||
    !product ||
    !rolePolicy ||
    !hasBearer(request, expectedSecret)
  ) {
    return json({ error: 'unauthorized' }, { status: 401 })
  }
  if (
    parsed.data.identities.some((identity) =>
      identity.memberships.some((membership) => !rolePolicy.roles.has(membership.role)),
    )
  ) {
    return json({ error: 'invalid_role' }, { status: 400 })
  }

  const compatibleSources = [...current.identityMigrationSourceByClient.entries()]
    .filter(
      ([clientId, candidate]) =>
        clientId !== parsed.data.client_id &&
        candidate !== source &&
        current.clientProductMap.get(clientId) === product,
    )
    .map(([, candidate]) => candidate)
  const requestSha256 = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')

  try {
    const result = await synchronizeIdentityBatch({
      requestSha256,
      clientId: parsed.data.client_id,
      source,
      compatibleSources,
      admissionScope,
      sourceSnapshot: parsed.data.source_snapshot,
      identities: parsed.data.identities.map((identity) => ({
        sourceUserId: identity.source_user_id,
        email: identity.email,
        ...(identity.first_name ? { firstName: identity.first_name } : {}),
        ...(identity.last_name ? { lastName: identity.last_name } : {}),
        ...(identity.password_hash ? { passwordHash: identity.password_hash } : {}),
        state: identity.state,
        memberships: identity.memberships.map((membership) => ({
          tenantId: membership.tenant_id,
          role: membership.role,
        })),
      })),
    })
    return json(result)
  } catch (caught) {
    if (caught instanceof IdentitySyncError) {
      return json({ error: caught.code }, { status: caught.status })
    }
    return json({ error: 'identity_sync_unavailable' }, { status: 503 })
  }
}
