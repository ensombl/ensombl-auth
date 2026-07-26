import { describe, expect, it } from 'vitest'
import { migrationDatabaseUrl } from '../scripts/migration-database-url'

const hostedMigrationUrl =
  'postgres://auth_control_migrator:hosted-password@postgres:5432/auth_control?sslmode=disable&options=-c%20role%3Dauth_control_owner'

describe('migration database boundary', () => {
  it('ignores an ambient runtime DATABASE_URL', () => {
    expect(
      migrationDatabaseUrl({
        NODE_ENV: 'development',
        DATABASE_URL:
          'postgres://auth_control_runtime:runtime-password@remote.invalid:5432/unrelated',
      }),
    ).toBe(
      'postgres://auth_control_migrator:auth_control_migrator_dev@localhost:25432/auth_control?options=-c%20role%3Dauth_control_owner',
    )
  })

  it('uses only the dedicated migration URL', () => {
    expect(
      migrationDatabaseUrl({
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgres://auth_control_runtime:runtime-password@remote.invalid:5432/unrelated',
        AUTH_CONTROL_MIGRATION_URL: hostedMigrationUrl,
      }),
    ).toBe(hostedMigrationUrl)
  })

  it('requires the dedicated URL in production', () => {
    expect(() =>
      migrationDatabaseUrl({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://auth_control_runtime:runtime-password@postgres:5432/auth_control',
      }),
    ).toThrow(/AUTH_CONTROL_MIGRATION_URL.*explicitly configured/)
  })

  it('rejects an ambient remote migration URL outside production', () => {
    expect(() =>
      migrationDatabaseUrl({
        NODE_ENV: 'development',
        AUTH_CONTROL_MIGRATION_URL: hostedMigrationUrl,
      }),
    ).toThrow(/must use a loopback host outside production/)
  })

  it('rejects a loopback migration URL in production', () => {
    expect(() =>
      migrationDatabaseUrl({
        NODE_ENV: 'production',
        AUTH_CONTROL_MIGRATION_URL:
          'postgres://auth_control_migrator:password@localhost:25432/auth_control?options=-c%20role%3Dauth_control_owner',
      }),
    ).toThrow(/must use a non-loopback host in production/)
  })

  it.each([
    [
      'runtime credentials',
      'postgres://auth_control_runtime:password@postgres:5432/auth_control?options=-c%20role%3Dauth_control_owner',
    ],
    [
      'a different database',
      'postgres://auth_control_migrator:password@postgres:5432/other?options=-c%20role%3Dauth_control_owner',
    ],
    ['no owner assumption', 'postgres://auth_control_migrator:password@postgres:5432/auth_control'],
  ])('rejects %s in the dedicated URL', (_case, value) => {
    expect(() =>
      migrationDatabaseUrl({
        NODE_ENV: 'production',
        AUTH_CONTROL_MIGRATION_URL: value,
      }),
    ).toThrow(/Invalid AUTH_CONTROL_MIGRATION_URL/)
  })
})
