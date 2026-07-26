const localMigrationUrl =
  'postgres://auth_control_migrator:auth_control_migrator_dev@localhost:25432/auth_control?options=-c%20role%3Dauth_control_owner'

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
  if (decodeURIComponent(parsed.username) !== 'auth_control_migrator') {
    invalid('must authenticate as auth_control_migrator')
  }
  if (!parsed.password) {
    invalid('must include the migrator password')
  }
  if (parsed.pathname !== '/auth_control') {
    invalid('must target the auth_control database')
  }
  if (parsed.searchParams.get('options') !== '-c role=auth_control_owner') {
    invalid('must assume auth_control_owner')
  }
  if (environment.NODE_ENV === 'production' && isLoopback(parsed.hostname)) {
    invalid('must use a non-loopback host in production')
  }
  if (environment.NODE_ENV !== 'production' && !isLoopback(parsed.hostname)) {
    invalid('must use a loopback host outside production')
  }

  return value
}
