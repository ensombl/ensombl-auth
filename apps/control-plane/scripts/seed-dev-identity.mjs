import postgres from 'postgres'

const kratosAdminUrl = new URL('http://127.0.0.1:24434')
const ketoWriteUrl = new URL('http://127.0.0.1:24467')
const databaseUrl = 'postgres://auth_control:auth_control_dev@127.0.0.1:25432/auth_control'
const identityContract = {
  email: 'developer@freightclaims.test',
  password: 'FreightClaims-Dev-2026!',
  externalId: 'local-dev:freightclaims-human',
  product: 'freightclaims',
}

if (process.env.NODE_ENV === 'production') {
  throw new Error('The deterministic development identity is forbidden in production')
}
for (const url of [kratosAdminUrl, ketoWriteUrl, new URL(databaseUrl)]) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('The deterministic development identity requires loopback-only dependencies')
  }
}

const lookupUrl = new URL('/admin/identities', kratosAdminUrl)
lookupUrl.searchParams.set('credentials_identifier', identityContract.email)
const lookup = await fetch(lookupUrl, { signal: AbortSignal.timeout(5_000) })
if (!lookup.ok) throw new Error(`Kratos identity lookup failed (${lookup.status})`)
const matches = await lookup.json()
if (!Array.isArray(matches) || matches.length > 1) {
  throw new Error('The deterministic development identity email is not unique')
}

let identity = matches[0]
if (identity && identity.external_id !== identityContract.externalId) {
  throw new Error('The deterministic development email belongs to another identity')
}
if (!identity) {
  const created = await fetch(new URL('/admin/identities', kratosAdminUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schema_id: 'default',
      state: 'inactive',
      external_id: identityContract.externalId,
      traits: {
        email: identityContract.email,
        name: {
          first: 'FreightClaims',
          last: 'Developer',
        },
      },
      credentials: {
        password: {
          config: {
            password: identityContract.password,
          },
        },
      },
      metadata_admin: {
        local_development_fixture: true,
      },
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (created.status !== 201) {
    throw new Error(`Kratos development identity creation failed (${created.status})`)
  }
  identity = await created.json()
}

if (!identity?.id || !['active', 'inactive'].includes(identity.state)) {
  throw new Error('Kratos returned an invalid development identity')
}

const sql = postgres(databaseUrl, { max: 1 })
try {
  const gates = await sql`
    select reset_required
    from auth_control.identity_gates
    where identity_id = ${identity.id}::uuid
  `
  if (gates[0]?.reset_required === true) {
    throw new Error('Development identity unexpectedly has a migration reset gate')
  }
} finally {
  await sql.end()
}

const granted = await fetch(new URL('/admin/relation-tuples', ketoWriteUrl), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    namespace: 'Product',
    object: identityContract.product,
    relation: 'members',
    subject_id: identity.id,
  }),
  signal: AbortSignal.timeout(5_000),
})
if (!granted.ok) throw new Error(`Keto development admission failed (${granted.status})`)

if (identity.state === 'inactive') {
  const activated = await fetch(new URL(`/admin/identities/${identity.id}`, kratosAdminUrl), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json-patch+json' },
    body: JSON.stringify([{ op: 'replace', path: '/state', value: 'active' }]),
    signal: AbortSignal.timeout(5_000),
  })
  if (!activated.ok) {
    throw new Error(`Kratos development identity activation failed (${activated.status})`)
  }
}

console.info(`Development identity ready: ${identityContract.email} (${identity.id})`)
