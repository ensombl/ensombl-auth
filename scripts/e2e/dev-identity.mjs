import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const email = 'developer@freightclaims.test'
const password = 'FreightClaims-Dev-2026!'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function findIdentity() {
  const url = new URL('/admin/identities', 'http://127.0.0.1:24434')
  url.searchParams.set('credentials_identifier', email)
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  assert(response.ok, `Kratos identity lookup returned ${response.status}`)
  const identities = await response.json()
  assert(Array.isArray(identities) && identities.length === 1, 'Seed identity is not unique')
  return identities[0]
}

await execFileAsync('pnpm', ['identity:seed:dev'])
const first = await findIdentity()
await execFileAsync('pnpm', ['identity:seed:dev'])
const second = await findIdentity()
assert(first.id === second.id, 'Development seed created a second identity')
assert(second.external_id === 'local-dev:freightclaims-human', 'Seed external ID drifted')
assert(second.state === 'active', 'Seed identity is not active')

const loginFlowResponse = await fetch(
  'http://127.0.0.1:24433/self-service/login/api',
  {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  },
)
assert(loginFlowResponse.ok, `Kratos login flow returned ${loginFlowResponse.status}`)
const loginFlow = await loginFlowResponse.json()
const login = await fetch(loginFlow.ui.action, {
  method: 'POST',
  headers: {
    accept: 'application/json',
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    method: 'password',
    identifier: email,
    password,
  }),
  signal: AbortSignal.timeout(10_000),
})
assert(login.ok, `Development password login returned ${login.status}`)
const loginResult = await login.json()
assert(loginResult.session?.active === true, 'Development login did not create an active session')
assert(loginResult.session?.identity?.id === second.id, 'Development login identity drifted')

const relationUrl = new URL(
  '/relation-tuples/check/openapi',
  'http://127.0.0.1:24466',
)
relationUrl.searchParams.set('namespace', 'Product')
relationUrl.searchParams.set('object', 'freightclaims:local')
relationUrl.searchParams.set('relation', 'access')
relationUrl.searchParams.set('subject_id', second.id)
const relation = await fetch(relationUrl, { signal: AbortSignal.timeout(5_000) })
assert(relation.ok, `Keto relation check returned ${relation.status}`)
assert((await relation.json()).allowed === true, 'Development identity lacks Product admission')

const administrationUrl = new URL(
  '/relation-tuples/check/openapi',
  'http://127.0.0.1:24466',
)
administrationUrl.searchParams.set('namespace', 'Product')
administrationUrl.searchParams.set('object', 'freightclaims')
administrationUrl.searchParams.set('relation', 'administer')
administrationUrl.searchParams.set('subject_id', second.id)
const administration = await fetch(administrationUrl, {
  signal: AbortSignal.timeout(5_000),
})
assert(administration.ok, `Keto administration check returned ${administration.status}`)
assert(
  (await administration.json()).allowed === true,
  'Development identity lacks product administration',
)

const { stdout: gate } = await execFileAsync('docker', [
  'compose',
  'exec',
  '-T',
  'auth-control-postgres',
  'psql',
  '--no-psqlrc',
  '--quiet',
  '--tuples-only',
  '--no-align',
  '--username',
  'auth_control',
  '--dbname',
  'auth_control',
  '--command',
  `select count(*) from public.identity_gates where identity_id = '${second.id}'::uuid and reset_required`,
])
assert(gate.trim() === '0', 'Development identity was conflated with a migration reset gate')

console.info(`Development identity seed/login policy passed (${second.id}).`)
