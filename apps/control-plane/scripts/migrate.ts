import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { migrationDatabaseUrl } from './migration-database-url'

const client = postgres(migrationDatabaseUrl())
const database = drizzle(client)

try {
  await migrate(database, {
    migrationsFolder: resolve(process.cwd(), 'migrations'),
  })
  console.info('Auth control Drizzle migrations are current')
} finally {
  await client.end()
}
