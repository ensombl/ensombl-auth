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
