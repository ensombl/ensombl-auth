import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { loadProductCatalog } from './product-catalog'

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
  INVITATION_RECONCILER_SECRET: 'local-only-invitation-reconciler-secret',
  PRODUCT_CATALOG_PATH:
    [
      resolve(process.cwd(), 'deploy/products/products.local.json'),
      resolve(process.cwd(), '../../deploy/products/products.local.json'),
    ].find(existsSync) ?? resolve(process.cwd(), 'deploy/products/products.local.json'),
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
  INVITATION_RECONCILER_SECRET: z
    .string()
    .min(24)
    .default(localDefaults.INVITATION_RECONCILER_SECRET),
  PRODUCT_CATALOG_PATH: z.string().min(1).default(localDefaults.PRODUCT_CATALOG_PATH),
})

type ParsedConfig = z.infer<typeof schema>

export type AppConfig = ParsedConfig & {
  authorizationDecisionSecrets: ReadonlyMap<string, string>
  identityManagementSecrets: ReadonlyMap<string, string>
  clientProductMap: ReadonlyMap<string, string>
  trustedClientIds: ReadonlySet<string>
  returnOrigins: ReadonlySet<string>
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
  'INVITATION_RECONCILER_SECRET',
  'PRODUCT_CATALOG_PATH',
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

  const publicAuthUrl = new URL(parsed.PUBLIC_AUTH_URL)
  if (publicAuthUrl.protocol !== 'https:' || isLocalHostname(publicAuthUrl.hostname)) {
    violations.push('PUBLIC_AUTH_URL must be a non-local HTTPS URL')
  }
  if (!parsed.PRODUCT_CATALOG_PATH.startsWith('/')) {
    violations.push('PRODUCT_CATALOG_PATH must be absolute in production')
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
  const productCatalog = loadProductCatalog(parsed.PRODUCT_CATALOG_PATH)
  const authorizationDecisionSecrets = new Map<string, string>()
  const identityManagementSecrets = new Map<string, string>()
  for (const [clientId, environmentName] of productCatalog.authorizationSecretEnvironmentByClient) {
    const configured = process.env[environmentName]?.trim()
    const secret =
      configured ??
      (parsed.NODE_ENV === 'production'
        ? undefined
        : `local-only-${clientId}-authorization-decision-secret`)
    if (!secret || secret.length < 32) {
      throw new Error(
        `${environmentName} must provide at least 32 characters for authorization decisions`,
      )
    }
    authorizationDecisionSecrets.set(clientId, secret)
  }
  for (const [
    clientId,
    environmentName,
  ] of productCatalog.identityManagementSecretEnvironmentByClient) {
    const configured = process.env[environmentName]?.trim()
    const secret =
      configured ??
      (parsed.NODE_ENV === 'production'
        ? undefined
        : `local-only-${clientId}-identity-management-secret`)
    if (!secret || secret.length < 32) {
      throw new Error(
        `${environmentName} must provide at least 32 characters for identity management`,
      )
    }
    identityManagementSecrets.set(clientId, secret)
  }
  if (
    parsed.NODE_ENV === 'production' &&
    new Set(authorizationDecisionSecrets.values()).size !== authorizationDecisionSecrets.size
  ) {
    throw new Error('Authorization decision secrets must be pairwise unique')
  }
  const productClientSecrets = [
    ...authorizationDecisionSecrets.values(),
    ...identityManagementSecrets.values(),
  ]
  if (
    parsed.NODE_ENV === 'production' &&
    new Set(productClientSecrets).size !== productClientSecrets.length
  ) {
    throw new Error('Product client capability secrets must be pairwise unique')
  }
  cached = {
    ...parsed,
    ...productCatalog,
    authorizationDecisionSecrets,
    identityManagementSecrets,
  }
  return cached
}

export function resetConfigForTest(): void {
  cached = undefined
}
