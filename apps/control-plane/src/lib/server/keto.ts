import { config } from './config'
import type { TenantRolePolicy } from './product-catalog'

async function readProductPermission(
  identityId: string,
  product: string,
  permission: 'access' | 'administer',
  strict: boolean,
): Promise<boolean> {
  const url = new URL('relation-tuples/check/openapi', `${config().KETO_READ_URL}/`)
  url.searchParams.set('namespace', 'Product')
  url.searchParams.set('object', product)
  url.searchParams.set('relation', permission)
  url.searchParams.set('subject_id', identityId)

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    console.error('Keto admission check failed', { status: response.status })
    if (strict) throw new Error('Unable to read product admission')
    return false
  }
  const result = (await response.json()) as { allowed?: boolean }
  return result.allowed === true
}

export function hasProductAdmission(identityId: string, product: string): Promise<boolean> {
  return readProductPermission(identityId, product, 'access', false)
}

export function hasProductAdmissionStrict(identityId: string, product: string): Promise<boolean> {
  return readProductPermission(identityId, product, 'access', true)
}

export function hasProductAdministrationStrict(
  identityId: string,
  product: string,
): Promise<boolean> {
  return readProductPermission(identityId, product, 'administer', true)
}

export async function hasTenantPermissionStrict(
  identityId: string,
  product: string,
  tenantId: string,
  permission: string,
  rolePolicy: TenantRolePolicy,
): Promise<boolean> {
  if (!(await readProductPermission(identityId, product, 'access', true))) return false

  for (const role of rolePolicy.roles.values()) {
    if (!role.permissions.has(permission)) continue
    const url = new URL('relation-tuples/check/openapi', `${config().KETO_READ_URL}/`)
    url.searchParams.set('namespace', 'TenantRole')
    url.searchParams.set('object', tenantRoleObject(product, tenantId, role.id))
    url.searchParams.set('relation', 'assigned')
    url.searchParams.set('subject_id', identityId)

    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      console.error('Keto tenant role decision failed', { status: response.status })
      throw new Error('Unable to read tenant permission')
    }
    const result = (await response.json()) as { allowed?: boolean }
    if (result.allowed === true) return true
  }
  return false
}

export async function grantProductAdmission(identityId: string, product: string): Promise<void> {
  const response = await fetch(new URL('admin/relation-tuples', `${config().KETO_WRITE_URL}/`), {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      namespace: 'Product',
      object: product,
      relation: 'members',
      subject_id: identityId,
    }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    console.error('Keto admission grant failed', { status: response.status })
    throw new Error('Unable to grant product admission')
  }
}

export async function revokeProductAdmission(identityId: string, product: string): Promise<void> {
  const url = new URL('admin/relation-tuples', `${config().KETO_WRITE_URL}/`)
  url.searchParams.set('namespace', 'Product')
  url.searchParams.set('object', product)
  url.searchParams.set('relation', 'members')
  url.searchParams.set('subject_id', identityId)
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  })
  if (![200, 204, 404].includes(response.status)) {
    console.error('Keto admission revoke failed', { status: response.status })
    throw new Error('Unable to revoke product admission')
  }
}

type RelationTuple = {
  namespace: 'TenantRole'
  object: string
  relation: string
  subject_id?: string
}

async function putTuple(tuple: RelationTuple): Promise<void> {
  const response = await fetch(new URL('admin/relation-tuples', `${config().KETO_WRITE_URL}/`), {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(tuple),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    console.error('Keto relation write failed', {
      namespace: tuple.namespace,
      relation: tuple.relation,
      status: response.status,
    })
    throw new Error('Unable to write tenant membership')
  }
}

async function deleteIdentityTuple(
  namespace: 'TenantRole',
  object: string,
  relation: 'assignees',
  identityId: string,
): Promise<void> {
  const url = new URL('admin/relation-tuples', `${config().KETO_WRITE_URL}/`)
  url.searchParams.set('namespace', namespace)
  url.searchParams.set('object', object)
  url.searchParams.set('relation', relation)
  url.searchParams.set('subject_id', identityId)
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  })
  if (![200, 204, 404].includes(response.status)) {
    console.error('Keto relation delete failed', {
      namespace,
      relation,
      status: response.status,
    })
    throw new Error('Unable to remove tenant membership')
  }
}

function tenantRoleObject(product: string, tenantId: string, role: string): string {
  return `${product}:${Buffer.from(tenantId).toString('base64url')}:${role}`
}

export async function setTenantMembership(input: {
  identityId: string
  tenantId: string
  product: string
  role: string
  rolePolicy: TenantRolePolicy
  state: 'active' | 'revoked'
}): Promise<void> {
  const selectedRole = input.rolePolicy.roles.get(input.role)
  if (!selectedRole) throw new Error(`Unknown tenant role: ${input.role}`)

  for (const role of input.rolePolicy.roles.keys()) {
    await deleteIdentityTuple(
      'TenantRole',
      tenantRoleObject(input.product, input.tenantId, role),
      'assignees',
      input.identityId,
    )
  }
  if (input.state === 'revoked') return

  await putTuple({
    namespace: 'TenantRole',
    object: tenantRoleObject(input.product, input.tenantId, input.role),
    relation: 'assignees',
    subject_id: input.identityId,
  })
}
