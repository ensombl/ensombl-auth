import { readFile } from 'node:fs/promises'

const catalogPath = required('PRODUCT_CATALOG_PATH')
const hydraAdminUrl = new URL(required('HYDRA_ADMIN_URL'))
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))

if (catalog?.schema_version !== 1 || !Array.isArray(catalog.products)) {
  throw new Error('Unsupported product catalog')
}

const seenClients = new Set()
const seenAudiences = new Set()
const seenSecrets = new Set()
for (const product of catalog.products) {
  assertIdentifier(product?.id, 'product ID')
  if (!Array.isArray(product.clients) || product.clients.length === 0) {
    throw new Error(`Product ${product.id} has no clients`)
  }
  for (const client of product.clients) {
    assertClientIdentifier(client?.id)
    assertIdentifier(client?.audience, `audience for ${client.id}`)
    if (seenClients.has(client.id)) throw new Error(`Duplicate client ID: ${client.id}`)
    if (seenAudiences.has(client.audience)) {
      throw new Error(`Duplicate audience: ${client.audience}`)
    }
    seenClients.add(client.id)
    seenAudiences.add(client.audience)

    const baseUrl = new URL(client.base_url)
    if (baseUrl.protocol !== 'https:' || baseUrl.origin !== client.base_url) {
      throw new Error(`Hosted client ${client.id} must use an HTTPS origin`)
    }
    const secret = required(client.secret_environment)
    if (secret.length < 32 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
      throw new Error(`${client.secret_environment} must be a URL-safe 32+ character secret`)
    }
    if (seenSecrets.has(secret)) {
      throw new Error('Each product client must use a distinct secret')
    }
    seenSecrets.add(secret)

    const document = {
      client_id: client.id,
      client_secret: secret,
      client_name: client.display_name,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid offline_access email profile',
      audience: [client.audience],
      redirect_uris: [`${baseUrl.origin}/auth/callback`],
      post_logout_redirect_uris: [`${baseUrl.origin}/`],
      token_endpoint_auth_method: 'client_secret_basic',
      metadata: { ensombl_product: product.id, first_party: true },
    }
    await reconcileClient(client.id, document)
  }
}

console.info(`Product catalog reconciled: clients=${seenClients.size}`)

function required(key) {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
}

function assertClientIdentifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error('Invalid client ID')
  }
}

async function reconcileClient(clientId, document) {
  const clientUrl = new URL(`/admin/clients/${encodeURIComponent(clientId)}`, hydraAdminUrl)
  const current = await fetch(clientUrl, { signal: AbortSignal.timeout(10_000) })
  if (current.status !== 200 && current.status !== 404) {
    throw new Error(`Hydra client lookup failed for ${clientId}: ${current.status}`)
  }
  const endpoint = current.status === 404 ? new URL('/admin/clients', hydraAdminUrl) : clientUrl
  const response = await fetch(endpoint, {
    method: current.status === 404 ? 'POST' : 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(document),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`Hydra client reconciliation failed for ${clientId}: ${response.status}`)
  }
}
