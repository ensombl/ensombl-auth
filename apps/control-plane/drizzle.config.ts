import { defineConfig } from 'drizzle-kit'
import { migrationDatabaseUrl } from './scripts/migration-database-url'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/server/database-schema.ts',
  out: './migrations',
  dbCredentials: {
    url: migrationDatabaseUrl(),
  },
  strict: true,
  verbose: true,
})
