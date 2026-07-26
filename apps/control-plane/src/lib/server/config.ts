import { z } from 'zod'

const url = z.string().url()

const localDefaults = {
  PUBLIC_AUTH_URL: 'http://localhost:24455',
  KRATOS_PUBLIC_INTERNAL_URL: 'http://localhost:24433',
  KRATOS_ADMIN_URL: 'http://localhost:24434',
  HYDRA_ADMIN_URL: 'http://localhost:24445',
  KETO_READ_URL: 'http://localhost:24466',
  KETO_WRITE_URL: 'http://localhost:24467',
  DATABASE_URL:
    'postgres://auth_control_runtime:auth_control_runtime_dev@localhost:25432/auth_control',
  ORY_HOOK_SECRET: 'local-only-hook-secret-32-bytes',
  MIGRATION_API_SECRET: 'local-only-migration-api-secret',
  INVITATION_API_SECRET: 'local-only-invitation-api-secret',
  INVITATION_RECONCILER_SECRET: 'local-only-invitation-reconciler-secret',
  INVITATION_SERVICE_ACTOR: 'service:local-invitation-api',
  FREIGHTCLAIMS_BASE_URL: 'http://localhost:4200',
  CLIENT_PRODUCT_MAP_JSON: '{"freightclaims-local-web":"freightclaims"}',
  TRUSTED_CLIENT_IDS: 'freightclaims-local-web',
} as const

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PUBLIC_AUTH_URL: url.default(localDefaults.PUBLIC_AUTH_URL),
  KRATOS_PUBLIC_INTERNAL_URL: url.default(localDefaults.KRATOS_PUBLIC_INTERNAL_URL),
  KRATOS_ADMIN_URL: url.default(localDefaults.KRATOS_ADMIN_URL),
  HYDRA_ADMIN_URL: url.default(localDefaults.HYDRA_ADMIN_URL),
  KETO_READ_URL: url.default(localDefaults.KETO_READ_URL),
  KETO_WRITE_URL: url.default(localDefaults.KETO_WRITE_URL),
  DATABASE_URL: z.string().min(1).default(localDefaults.DATABASE_URL),
  ORY_HOOK_SECRET: z.string().min(24).default(localDefaults.ORY_HOOK_SECRET),
  MIGRATION_API_SECRET: z.string().min(24).default(localDefaults.MIGRATION_API_SECRET),
  INVITATION_API_SECRET: z.string().min(24).default(localDefaults.INVITATION_API_SECRET),
  INVITATION_RECONCILER_SECRET: z
    .string()
    .min(24)
    .default(localDefaults.INVITATION_RECONCILER_SECRET),
  INVITATION_SERVICE_ACTOR: z
    .string()
    .min(1)
    .max(200)
    .default(localDefaults.INVITATION_SERVICE_ACTOR),
  FREIGHTCLAIMS_BASE_URL: url.default(localDefaults.FREIGHTCLAIMS_BASE_URL),
  CLIENT_PRODUCT_MAP_JSON: z.string().default(localDefaults.CLIENT_PRODUCT_MAP_JSON),
  TRUSTED_CLIENT_IDS: z.string().default(localDefaults.TRUSTED_CLIENT_IDS),
})

type ParsedConfig = z.infer<typeof schema>

export type AppConfig = ParsedConfig & {
  clientProductMap: ReadonlyMap<string, string>
  trustedClientIds: ReadonlySet<string>
}

let cached: AppConfig | undefined

const productionRequiredKeys = [
  'PUBLIC_AUTH_URL',
  'KRATOS_PUBLIC_INTERNAL_URL',
  'KRATOS_ADMIN_URL',
  'HYDRA_ADMIN_URL',
  'KETO_READ_URL',
  'KETO_WRITE_URL',
  'DATABASE_URL',
  'ORY_HOOK_SECRET',
  'MIGRATION_API_SECRET',
  'INVITATION_API_SECRET',
  'INVITATION_RECONCILER_SECRET',
  'INVITATION_SERVICE_ACTOR',
  'FREIGHTCLAIMS_BASE_URL',
  'CLIENT_PRODUCT_MAP_JSON',
  'TRUSTED_CLIENT_IDS',
] as const satisfies readonly (keyof typeof localDefaults)[]

const internalUrlKeys = [
  'KRATOS_PUBLIC_INTERNAL_URL',
  'KRATOS_ADMIN_URL',
  'HYDRA_ADMIN_URL',
  'KETO_READ_URL',
  'KETO_WRITE_URL',
] as const satisfies readonly (keyof ParsedConfig)[]

const bearerSecretKeys = [
  'ORY_HOOK_SECRET',
  'MIGRATION_API_SECRET',
  'INVITATION_API_SECRET',
  'INVITATION_RECONCILER_SECRET',
] as const satisfies readonly (keyof ParsedConfig)[]

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized.startsWith('127.') ||
    normalized === 'host.docker.internal'
  )
}

function assertProductionConfig(parsed: ParsedConfig, environment: NodeJS.ProcessEnv): void {
  if (parsed.NODE_ENV !== 'production') return

  const violations: string[] = []
  for (const key of productionRequiredKeys) {
    if (!environment[key]?.trim()) violations.push(`${key} must be explicitly configured`)
  }

  for (const key of ['PUBLIC_AUTH_URL', 'FREIGHTCLAIMS_BASE_URL'] as const) {
    const configured = new URL(parsed[key])
    if (configured.protocol !== 'https:' || isLocalHostname(configured.hostname)) {
      violations.push(`${key} must be a non-local HTTPS URL`)
    }
  }

  for (const key of internalUrlKeys) {
    if (isLocalHostname(new URL(parsed[key]).hostname)) {
      violations.push(`${key} must not use a local host`)
    }
  }

  const databaseUrl = new URL(parsed.DATABASE_URL)
  if (
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    isLocalHostname(databaseUrl.hostname)
  ) {
    violations.push('DATABASE_URL must be an explicit non-local PostgreSQL URL')
  }

  for (const key of bearerSecretKeys) {
    if (parsed[key] === localDefaults[key] || parsed[key].startsWith('local-only-')) {
      violations.push(`${key} must not use the development secret`)
    }
  }

  for (let left = 0; left < bearerSecretKeys.length; left += 1) {
    for (let right = left + 1; right < bearerSecretKeys.length; right += 1) {
      const leftKey = bearerSecretKeys[left]
      const rightKey = bearerSecretKeys[right]
      if (leftKey && rightKey && parsed[leftKey] === parsed[rightKey]) {
        violations.push(`${rightKey} must differ from ${leftKey}`)
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`Invalid production configuration: ${violations.join('; ')}`)
  }
}

export function config(): AppConfig {
  if (cached) return cached

  const parsed = schema.parse(process.env)
  assertProductionConfig(parsed, process.env)
  const mapping = z
    .record(z.string(), z.string().min(1))
    .parse(JSON.parse(parsed.CLIENT_PRODUCT_MAP_JSON))
  cached = {
    ...parsed,
    clientProductMap: new Map(Object.entries(mapping)),
    trustedClientIds: new Set(
      parsed.TRUSTED_CLIENT_IDS.split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  }
  return cached
}

export function resetConfigForTest(): void {
  cached = undefined
}
