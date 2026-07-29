import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const kratosAdminUrl = 'http://127.0.0.1:24434'
const ketoReadUrl = 'http://127.0.0.1:24466'
const ketoWriteUrl = 'http://127.0.0.1:24467'
const source = 'freightclaims-fc-stage'
const organizationId = '01900000-0000-7000-8000-000000000001'
const phc =
  '$argon2id$v=19$m=65536,t=3,p=1$ABEiM0RVZneImaq7zN3u/w$jim7J9d1PKX/dB5E1eecZ7D4dPr1vTwkTf4I+Q3IeMQ'
const failurePoints = [
  'after_kratos_create',
  'after_identity_created',
  'after_reset_gated',
  'after_products_granted',
  'after_identity_activated',
]
const runId = `${Date.now()}-${process.pid}`
const workDirectory = await mkdtemp(join(tmpdir(), 'ensombl-auth-import-e2e-'))
const testRecords = []

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: new URL('../..', import.meta.url),
      stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    if (options.input !== undefined) child.stdin.end(options.input)
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function requireReady(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`${label} is not ready (${response.status})`)
}

async function adminSql(statement) {
  const result = await run('docker', [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '--no-psqlrc',
    '--quiet',
    '--tuples-only',
    '--no-align',
    '--username',
    'postgres',
    '--dbname',
    'auth_control',
    '--command',
    statement,
  ])
  if (result.code !== 0) throw new Error(`Admin SQL failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

async function findIdentity(email) {
  const url = new URL('/admin/identities', kratosAdminUrl)
  url.searchParams.set('credentials_identifier', email)
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`Kratos identity lookup failed (${response.status})`)
  const identities = await response.json()
  if (!Array.isArray(identities) || identities.length > 1) {
    throw new Error('Kratos identity lookup was not unique')
  }
  return identities[0]
}

async function hasProduct(identityId) {
  const url = new URL('/relation-tuples/check/openapi', ketoReadUrl)
  url.searchParams.set('namespace', 'Product')
  url.searchParams.set('object', 'freightclaims')
  url.searchParams.set('relation', 'access')
  url.searchParams.set('subject_id', identityId)
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`Keto relation check failed (${response.status})`)
  return (await response.json()).allowed === true
}

async function hasTenant(identityId) {
  const url = new URL('/relation-tuples/check/openapi', ketoReadUrl)
  url.searchParams.set('namespace', 'Tenant')
  url.searchParams.set('object', `freightclaims:${organizationId}`)
  url.searchParams.set('relation', 'access')
  url.searchParams.set('subject_id', identityId)
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`Keto tenant relation check failed (${response.status})`)
  return (await response.json()).allowed === true
}

async function runImporter(manifest, expectedHash, failurePoint, allowedSource = source) {
  const args = [
    'compose',
    '--profile',
    'identity-import',
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '-e',
    `IDENTITY_IMPORT_EXPECTED_SHA256=${expectedHash}`,
    '-e',
    `IDENTITY_IMPORT_ALLOWED_SOURCE=${allowedSource}`,
  ]
  if (failurePoint) {
    args.push('-e', `IDENTITY_IMPORT_TEST_FAILURE_AFTER=${failurePoint}`)
  }
  args.push('identity-import')
  return run('docker', args, { input: manifest })
}

async function cleanupRecord(record) {
  const identity = await findIdentity(record.email).catch(() => undefined)
  const identityId = identity?.id
  if (identityId) {
    const tupleUrl = new URL('/admin/relation-tuples', ketoWriteUrl)
    tupleUrl.searchParams.set('namespace', 'Product')
    tupleUrl.searchParams.set('object', 'freightclaims')
    tupleUrl.searchParams.set('relation', 'members')
    tupleUrl.searchParams.set('subject_id', identityId)
    await fetch(tupleUrl, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined)
    const organizationTupleUrl = new URL('/admin/relation-tuples', ketoWriteUrl)
    organizationTupleUrl.searchParams.set('namespace', 'Organization')
    organizationTupleUrl.searchParams.set('object', organizationId)
    organizationTupleUrl.searchParams.set('relation', 'members')
    organizationTupleUrl.searchParams.set('subject_id', identityId)
    await fetch(organizationTupleUrl, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined)
    organizationTupleUrl.searchParams.set('relation', 'administrators')
    await fetch(organizationTupleUrl, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined)
    await fetch(new URL(`/admin/identities/${identityId}`, kratosAdminUrl), {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined)
  }

  const escapedUserId = record.sourceUserId.replaceAll("'", "''")
  const escapedHash = record.hash.replaceAll("'", "''")
  const identityPredicate = identityId ? `'${identityId}'::uuid` : 'null::uuid'
  await adminSql(`
    delete from auth_control.identity_gates
    where identity_id = ${identityPredicate};
    delete from auth_control.identity_import_entries
    where source = '${record.source ?? source}' and source_user_id = '${escapedUserId}';
    delete from auth_control.identity_import_batches
    where manifest_sha256 = '${escapedHash}';
  `).catch(() => undefined)
}

try {
  await requireReady(`${kratosAdminUrl}/health/ready`, 'Kratos admin')
  await requireReady(`${ketoReadUrl}/health/ready`, 'Keto read')

  const build = await run('docker', [
    'compose',
    '--profile',
    'identity-import',
    'build',
    'identity-import',
  ])
  if (build.code !== 0) throw new Error(`Importer source build failed: ${build.stderr}`)

  const invalidManifest = JSON.stringify({
    schema_version: 1,
    source,
    source_snapshot: `synthetic-${runId}-invalid`,
    identities: [
      {
        source_user_id: `synthetic-${runId}-invalid`,
        email: `import-${runId}-invalid@example.test`,
        first_name: 'bad\u0001name',
        last_name: 'Probe',
        password_hash: phc,
        reset_required: true,
        products: ['freightclaims'],
        tenants: [
          {
            product: 'freightclaims',
            organization_id: organizationId,
            relation: 'members',
          },
        ],
      },
    ],
  })
  const invalidHash = createHash('sha256').update(invalidManifest).digest('hex')
  const invalidResult = await runImporter(invalidManifest, invalidHash)
  if (invalidResult.code === 0 || !invalidResult.stderr.includes('invalid_manifest_schema')) {
    throw new Error('Control-character name was not rejected before import')
  }

  for (const [index, failurePoint] of failurePoints.entries()) {
    const sourceUserId = `synthetic-${runId}-${index}`
    const email = `import-${runId}-${index}@example.test`
    const manifest = `${JSON.stringify({
      schema_version: 1,
      source,
      source_snapshot: `synthetic-${runId}-${index}`,
      identities: [
        {
          source_user_id: sourceUserId,
          email,
          first_name: 'Import',
          last_name: 'Probe',
          password_hash: phc,
          reset_required: true,
          products: ['freightclaims'],
          tenants: [
            {
              product: 'freightclaims',
              organization_id: organizationId,
              relation: 'members',
            },
          ],
        },
      ],
    })}\n`
    const hash = createHash('sha256').update(manifest).digest('hex')
    const record = { sourceUserId, email, hash }
    testRecords.push(record)
    await writeFile(join(workDirectory, `${index}.sha256`), `${hash}\n`, { mode: 0o600 })

    const failed = await runImporter(manifest, hash, failurePoint)
    if (failed.code === 0 || !failed.stderr.includes(`injected_${failurePoint}`)) {
      throw new Error(`Failure injection did not stop at ${failurePoint}`)
    }

    const partialIdentity = await findIdentity(email)
    if (!partialIdentity) throw new Error(`No resumable identity after ${failurePoint}`)
    const gate = await adminSql(`
      select coalesce((
        select reset_required::text
        from auth_control.identity_gates
        where identity_id = '${partialIdentity.id}'::uuid
      ), 'false')
    `)
    if (partialIdentity.state === 'active' && gate !== 'true') {
      throw new Error(`Active identity escaped its reset gate after ${failurePoint}`)
    }
    if (failurePoint !== 'after_identity_activated' && partialIdentity.state !== 'inactive') {
      throw new Error(`Identity activated too early after ${failurePoint}`)
    }

    const resumed = await runImporter(manifest, hash)
    if (resumed.code !== 0 || !resumed.stdout.includes('Identity import completed')) {
      throw new Error(`Importer did not resume ${failurePoint}: ${resumed.stderr}`)
    }
    const completedIdentity = await findIdentity(email)
    if (completedIdentity?.state !== 'active') {
      throw new Error(`Resumed identity is not active after ${failurePoint}`)
    }
    if (!(await hasProduct(completedIdentity.id))) {
      throw new Error(`Resumed identity has no Product admission after ${failurePoint}`)
    }
    if (!(await hasTenant(completedIdentity.id))) {
      throw new Error(`Resumed identity has no tenant admission after ${failurePoint}`)
    }
    const completedState = await adminSql(`
      select entry.status || '|' || gate.reset_required::text || '|' || batch.status
      from auth_control.identity_import_entries as entry
      join auth_control.identity_gates as gate on gate.identity_id = entry.identity_id
      join auth_control.identity_import_batches as batch
        on batch.manifest_sha256 = entry.manifest_sha256
      where entry.source = '${source}'
        and entry.source_user_id = '${sourceUserId}'
    `)
    if (completedState !== 'completed|true|completed') {
      throw new Error(`Completed ledger/gate mismatch after ${failurePoint}: ${completedState}`)
    }

    const repeated = await runImporter(manifest, hash)
    if (repeated.code !== 0 || !repeated.stdout.includes('already completed')) {
      throw new Error(`Completed batch was not idempotent after ${failurePoint}`)
    }
  }

  const staged = testRecords[0]
  if (!staged) throw new Error('No completed Stage identity is available for cross-source proof')
  const stagedIdentity = await findIdentity(staged.email)
  if (!stagedIdentity) throw new Error('Completed Stage identity is missing')
  await adminSql(`
    update auth_control.identity_gates
    set reset_required = false,
        reset_completed_at = now(),
        updated_at = now()
    where identity_id = '${stagedIdentity.id}'::uuid;
  `)
  const productionSource = 'freightclaims-fc-prod'
  const productionManifest = `${JSON.stringify({
    schema_version: 1,
    source: productionSource,
    source_snapshot: `synthetic-${runId}-prod-reuse`,
    identities: [
      {
        source_user_id: staged.sourceUserId,
        email: staged.email,
        first_name: 'Import',
        last_name: 'Probe',
        password_hash: phc,
        reset_required: true,
        products: ['freightclaims'],
        tenants: [
          {
            product: 'freightclaims',
            organization_id: organizationId,
            relation: 'members',
          },
        ],
      },
    ],
  })}\n`
  const productionHash = createHash('sha256').update(productionManifest).digest('hex')
  testRecords.push({
    sourceUserId: staged.sourceUserId,
    email: staged.email,
    hash: productionHash,
    source: productionSource,
  })
  const productionImport = await runImporter(
    productionManifest,
    productionHash,
    undefined,
    productionSource,
  )
  if (
    productionImport.code !== 0 ||
    !productionImport.stdout.includes('Identity import completed')
  ) {
    throw new Error(`Production source did not reuse Stage identity: ${productionImport.stderr}`)
  }
  const reusedIdentity = await findIdentity(staged.email)
  if (
    reusedIdentity?.id !== stagedIdentity.id ||
    reusedIdentity.external_id !== `${source}:${staged.sourceUserId}`
  ) {
    throw new Error('Production source duplicated or rebound the completed Stage identity')
  }
  const reusedState = await adminSql(`
    select
      entry.status || '|' ||
      gate.reset_required::text || '|' ||
      identity_entry.status
    from auth_control.identity_import_entries as entry
    join auth_control.identity_import_entries as identity_entry
      on identity_entry.identity_id = entry.identity_id
     and identity_entry.source = '${source}'
    join auth_control.identity_gates as gate
      on gate.identity_id = entry.identity_id
    where entry.source = '${productionSource}'
      and entry.source_user_id = '${staged.sourceUserId}'
  `)
  if (reusedState !== 'completed|false|completed') {
    throw new Error(`Cross-source reuse changed the completed reset state: ${reusedState}`)
  }

  console.info(
    `Identity importer split-failure/resume and Stage-to-Production reuse passed (${failurePoints.length} boundaries).`,
  )
} finally {
  for (const record of testRecords.reverse()) await cleanupRecord(record)
  await rm(workDirectory, { recursive: true, force: true })
}
