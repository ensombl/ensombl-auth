import { config } from './config'

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
  organizationId: string,
  permission: 'access' | 'administer',
): Promise<boolean> {
  const url = new URL('relation-tuples/check/openapi', `${config().KETO_READ_URL}/`)
  url.searchParams.set('namespace', 'Tenant')
  url.searchParams.set('object', `${product}:${organizationId}`)
  url.searchParams.set('relation', permission)
  url.searchParams.set('subject_id', identityId)

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    console.error('Keto tenant decision failed', { status: response.status })
    throw new Error('Unable to read tenant permission')
  }
  const result = (await response.json()) as { allowed?: boolean }
  return result.allowed === true
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

type RelationTuple = {
  namespace: 'Organization' | 'Tenant'
  object: string
  relation: string
  subject_id?: string
  subject_set?: {
    namespace: 'Organization' | 'Product'
    object: string
    relation: ''
  }
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
  namespace: 'Organization',
  object: string,
  relation: 'members' | 'administrators',
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

export async function setTenantMembership(input: {
  identityId: string
  organizationId: string
  product: string
  relation: 'members' | 'administrators'
  state: 'active' | 'revoked'
}): Promise<void> {
  if (input.state === 'revoked') {
    await deleteIdentityTuple(
      'Organization',
      input.organizationId,
      'administrators',
      input.identityId,
    )
    await deleteIdentityTuple('Organization', input.organizationId, 'members', input.identityId)
    return
  }

  const tenant = `${input.product}:${input.organizationId}`
  await putTuple({
    namespace: 'Tenant',
    object: tenant,
    relation: 'product',
    subject_set: { namespace: 'Product', object: input.product, relation: '' },
  })
  await putTuple({
    namespace: 'Tenant',
    object: tenant,
    relation: 'organization',
    subject_set: { namespace: 'Organization', object: input.organizationId, relation: '' },
  })

  if (input.relation === 'members') {
    await deleteIdentityTuple(
      'Organization',
      input.organizationId,
      'administrators',
      input.identityId,
    )
    await putTuple({
      namespace: 'Organization',
      object: input.organizationId,
      relation: 'members',
      subject_id: input.identityId,
    })
    return
  }

  await putTuple({
    namespace: 'Organization',
    object: input.organizationId,
    relation: 'administrators',
    subject_id: input.identityId,
  })
  await deleteIdentityTuple('Organization', input.organizationId, 'members', input.identityId)
}
