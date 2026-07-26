import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const endpoints = {
  auth: 'http://localhost:24455',
  kratosAdmin: 'http://localhost:24434',
  ketoRead: 'http://localhost:24466',
  ketoWrite: 'http://localhost:24467',
  control: 'http://localhost:3400',
}
const oauth = {
  clientId: 'freightclaims-local-web',
  clientSecret: 'local-only-freightclaims-secret-32',
  redirectUri: 'http://localhost:4200/auth/callback',
}
const oldPassword = 'Legacy-Password-2026!'
const newPassword = 'Replacement-Password-2026!'

// This fixed PHC was emitted by FreightClaims
// tools/migration/src/identity/argon2id.ts#hashPasswordForKratos using
// salt 00112233445566778899aabbccddeeff and oldPassword above.
const freightClaimsPhc =
  '$argon2id$v=19$m=65536,t=3,p=1$ABEiM0RVZneImaq7zN3u/w$jim7J9d1PKX/dB5E1eecZ7D4dPr1vTwkTf4I+Q3IeMQ'
const execFileAsync = promisify(execFile)

class CookieJar {
  #values = new Map()

  async fetch(input, init = {}) {
    const headers = new Headers(init.headers)
    if (this.#values.size > 0) {
      headers.set('cookie', [...this.#values].map(([name, value]) => `${name}=${value}`).join('; '))
    }
    const response = await fetch(input, {
      ...init,
      headers,
      redirect: 'manual',
      signal: init.signal ?? AbortSignal.timeout(10_000),
    })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0]
      const separator = pair.indexOf('=')
      if (separator < 1) continue
      const name = pair.slice(0, separator)
      const value = pair.slice(separator + 1)
      if (/;\s*max-age=0(?:;|$)/i.test(cookie) || value.length === 0) {
        this.#values.delete(name)
      } else {
        this.#values.set(name, value)
      }
    }
    return response
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function location(response, requestUrl) {
  assert(
    [302, 303, 307, 308].includes(response.status),
    `Expected redirect from ${requestUrl}; received ${response.status}`,
  )
  const value = response.headers.get('location')
  assert(value, `Redirect from ${requestUrl} omitted Location`)
  return new URL(value, requestUrl)
}

async function json(response, status, label) {
  assert(response.status === status, `${label} returned ${response.status}`)
  return response.json()
}

function form(flow, overrides) {
  const values = new URLSearchParams()
  for (const node of flow.ui.nodes) {
    const attributes = node.attributes
    if (
      attributes?.node_type === 'input' &&
      typeof attributes.name === 'string' &&
      attributes.value !== undefined
    ) {
      values.set(attributes.name, String(attributes.value))
    }
  }
  for (const [name, value] of Object.entries(overrides)) values.set(name, value)
  return values
}

async function flow(jar, kind, id) {
  const url = new URL(`/self-service/${kind}/flows`, endpoints.auth)
  url.searchParams.set('id', id)
  return json(await jar.fetch(url), 200, `${kind} flow`)
}

async function startFlow(jar, startUrl, kind) {
  const ui = location(await jar.fetch(startUrl), startUrl)
  const id = ui.searchParams.get('flow')
  assert(id, `${kind} redirect omitted flow`)
  return flow(jar, kind, id)
}

async function createIdentity(email) {
  const response = await fetch(new URL('/admin/identities', endpoints.kratosAdmin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schema_id: 'default',
      state: 'active',
      traits: { email },
      credentials: { password: { config: { hashed_password: freightClaimsPhc } } },
    }),
    signal: AbortSignal.timeout(10_000),
  })
  return json(response, 201, 'Kratos PHC import')
}

async function assertResetGate(identityId) {
  const response = await fetch(new URL('/internal/migration/reset-gates', endpoints.control), {
    method: 'PUT',
    headers: {
      authorization: 'Bearer local-only-migration-api-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      identities: [
        {
          identity_id: identityId,
          reset_required: true,
          source: 'local-e2e-freightclaims-phc',
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  })
  assert(response.ok, `Reset gate assertion returned ${response.status}`)
}

async function grantProduct(identityId) {
  const response = await fetch(new URL('/admin/relation-tuples', endpoints.ketoWrite), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      namespace: 'Product',
      object: 'freightclaims',
      relation: 'members',
      subject_id: identityId,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  assert(response.ok, `Keto relation write returned ${response.status}`)
}

async function removeProduct(identityId) {
  const url = new URL('/admin/relation-tuples', endpoints.ketoWrite)
  url.searchParams.set('namespace', 'Product')
  url.searchParams.set('object', 'freightclaims')
  url.searchParams.set('relation', 'members')
  url.searchParams.set('subject_id', identityId)
  await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(10_000) }).catch(() => {})
}

async function removeControlState(identityId) {
  assert(/^[0-9a-f-]{36}$/.test(identityId), 'Refusing cleanup for an invalid identity ID')
  const sql = `
    delete from auth_control.invitation_events
    where invitation_id in (
      select id from auth_control.invitations where identity_id = '${identityId}'::uuid
    );
    delete from auth_control.invitations where identity_id = '${identityId}'::uuid;
    delete from auth_control.hook_receipts where identity_id = '${identityId}'::uuid;
    delete from auth_control.identity_gates where identity_id = '${identityId}'::uuid;
  `
  await execFileAsync('docker', [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '--username',
    'postgres',
    '--dbname',
    'auth_control',
    '--set',
    'ON_ERROR_STOP=on',
    '--command',
    sql,
  ])
}

async function beginOAuth(jar, verifier) {
  const url = new URL('/oauth2/auth', endpoints.auth)
  url.searchParams.set('client_id', oauth.clientId)
  url.searchParams.set('redirect_uri', oauth.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', randomUUID())
  url.searchParams.set('nonce', randomUUID())
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
  url.searchParams.set('code_challenge_method', 'S256')
  return location(await jar.fetch(url), url)
}

async function login(jar, oauthLoginUrl, email, password) {
  const start = location(await jar.fetch(oauthLoginUrl), oauthLoginUrl)
  assert(start.pathname === '/self-service/login/browser', `Expected login; got ${start.pathname}`)
  const loginFlow = await startFlow(jar, start, 'login')
  const response = await jar.fetch(loginFlow.ui.action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(loginFlow, { identifier: email, password, method: 'password' }),
  })
  return location(response, loginFlow.ui.action)
}

async function forcedSettings(jar, oauthLoginUrl) {
  const start = location(await jar.fetch(oauthLoginUrl), oauthLoginUrl)
  assert(
    start.pathname === '/self-service/settings/browser',
    `Expected forced settings; got ${start.pathname}`,
  )
  return startFlow(jar, start, 'settings')
}

async function rejectSamePassword(jar, settingsFlow) {
  const response = await jar.fetch(settingsFlow.ui.action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(settingsFlow, { password: oldPassword, method: 'password' }),
  })

  let rejected
  if ([302, 303, 307, 308].includes(response.status)) {
    const ui = location(response, settingsFlow.ui.action)
    const id = ui.searchParams.get('flow')
    assert(id, 'Rejected settings redirect omitted flow')
    rejected = await flow(jar, 'settings', id)
  } else {
    assert([400, 422].includes(response.status), `Same password returned ${response.status}`)
    rejected = await response.json()
  }
  const message = [
    ...(rejected.ui.messages ?? []),
    ...rejected.ui.nodes.flatMap((node) => node.messages ?? []),
  ]
    .map((item) => item.text)
    .join(' ')
  assert(/same|different|current password/i.test(message), 'Same password was not rejected')
}

async function replacePassword(jar, settingsFlow) {
  const response = await jar.fetch(settingsFlow.ui.action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(settingsFlow, { password: newPassword, method: 'password' }),
  })
  return location(response, settingsFlow.ui.action)
}

async function finishOAuth(jar, startUrl) {
  let current = startUrl
  for (let redirects = 0; redirects < 12; redirects += 1) {
    const callback = new URL(oauth.redirectUri)
    if (current.origin === callback.origin && current.pathname === callback.pathname) return current
    current = location(await jar.fetch(current), current)
  }
  throw new Error('OAuth chain did not reach FreightClaims callback')
}

async function exchange(code, verifier) {
  const response = await fetch(new URL('/oauth2/token', endpoints.auth), {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: oauth.redirectUri,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  return json(response, 200, 'OAuth token exchange')
}

const email = `freight-phc-e2e-${Date.now()}@example.test`
const jar = new CookieJar()
let identityId

try {
  const identity = await createIdentity(email)
  identityId = identity.id
  assert(typeof identityId === 'string', 'Kratos did not return identity ID')
  await assertResetGate(identityId)
  await grantProduct(identityId)

  const verifier = randomBytes(48).toString('base64url')
  const oauthLogin = await beginOAuth(jar, verifier)
  const afterOldLogin = await login(jar, oauthLogin, email, oldPassword)
  const settings = await forcedSettings(jar, afterOldLogin)

  await rejectSamePassword(jar, settings)
  const stillForced = await forcedSettings(jar, afterOldLogin)
  const afterReset = await replacePassword(jar, stillForced)

  // The password hook revokes every Kratos session before clearing the gate.
  // A fresh login with the replacement password must now proceed without
  // another forced-settings redirect.
  const afterFreshLogin = await login(jar, afterReset, email, newPassword)
  const callback = await finishOAuth(jar, afterFreshLogin)
  const code = callback.searchParams.get('code')
  assert(code, 'FreightClaims callback omitted authorization code')
  const tokens = await exchange(code, verifier)
  assert(typeof tokens.access_token === 'string', 'Token exchange omitted access token')
  assert(typeof tokens.id_token === 'string', 'Token exchange omitted ID token')

  const admissionUrl = new URL('/relation-tuples/check/openapi', endpoints.ketoRead)
  admissionUrl.searchParams.set('namespace', 'Product')
  admissionUrl.searchParams.set('object', 'freightclaims')
  admissionUrl.searchParams.set('relation', 'access')
  admissionUrl.searchParams.set('subject_id', identityId)
  const admission = await (await fetch(admissionUrl)).json()
  assert(admission.allowed === true, 'Keto admission was lost')

  console.info(
    'FreightClaims PHC import, old login, forced reset, same-password rejection, session revocation, fresh login, OAuth code, and token exchange passed.',
  )
} finally {
  if (identityId) {
    await removeProduct(identityId)
    await fetch(new URL(`/admin/identities/${identityId}`, endpoints.kratosAdmin), {
      method: 'DELETE',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {})
    await removeControlState(identityId).catch(() => {})
  }
}
