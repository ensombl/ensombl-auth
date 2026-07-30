const localMigrationUrl = 'postgres://auth_control:auth_control_dev@localhost:25432/auth_control'

function invalid(message: string): never {
  throw new Error(`Invalid AUTH_CONTROL_MIGRATION_URL: ${message}`)
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    normalized.startsWith('127.')
  )
}

export function migrationDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.AUTH_CONTROL_MIGRATION_URL?.trim()
  if (!configured && environment.NODE_ENV === 'production') {
    invalid('must be explicitly configured in production')
  }

  const value = configured ?? localMigrationUrl
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    invalid('must be a valid URL')
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    invalid('must use PostgreSQL')
  }
  if (!decodeURIComponent(parsed.username)) {
    invalid('must include a database user')
  }
  if (!parsed.password) {
    invalid('must include the migrator password')
  }
  if (parsed.pathname !== '/auth_control') {
    invalid('must target the auth_control database')
  }
  if (environment.NODE_ENV === 'production' && isLoopback(parsed.hostname)) {
    invalid('must use a non-loopback host in production')
  }
  if (environment.NODE_ENV !== 'production' && !isLoopback(parsed.hostname)) {
    invalid('must use a loopback host outside production')
  }

  return value
}
