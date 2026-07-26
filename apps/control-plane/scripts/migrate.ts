import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { migrationDatabaseUrl } from './migration-database-url'

const sql = postgres(migrationDatabaseUrl(), { max: 1 })
const directory = resolve(process.cwd(), 'migrations')

try {
  await sql`select pg_advisory_lock(hashtext('ensombl-auth-control-migrations'))`
  await sql`create schema if not exists auth_control`
  await sql`
    create table if not exists auth_control.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `

  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()
  for (const name of files) {
    const applied = await sql`
      select 1
      from auth_control.schema_migrations
      where name = ${name}
    `
    if (applied.length > 0) continue

    const migration = await readFile(resolve(directory, name), 'utf8')
    await sql.begin(async (transaction) => {
      await transaction.unsafe(migration)
      await transaction`
        insert into auth_control.schema_migrations (name)
        values (${name})
      `
    })
    console.info(`Applied ${name}`)
  }
} finally {
  await sql`select pg_advisory_unlock(hashtext('ensombl-auth-control-migrations'))`.catch(() => {})
  await sql.end()
}
