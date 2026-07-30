import { and, eq, sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'
import { config } from './config'
import * as schema from './database-schema'
import { hookReceipts, identityGates } from './database-schema'

export type Database = PostgresJsDatabase<typeof schema>

let client: Sql | undefined
let database: Database | undefined

export function db(): Database {
  if (database) return database

  client = postgres(config().DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
    transform: {
      undefined: null,
    },
  })
  database = drizzle(client, { schema })
  return database
}

export async function closeDatabase(): Promise<void> {
  const activeClient = client
  database = undefined
  client = undefined
  await activeClient?.end()
}

export async function isResetRequired(identityId: string): Promise<boolean> {
  const rows = await db()
    .select({ resetRequired: identityGates.resetRequired })
    .from(identityGates)
    .where(eq(identityGates.identityId, identityId))
    .limit(1)
  return rows[0]?.resetRequired ?? false
}

export async function setResetGate(input: { identityId: string; source: string }): Promise<void> {
  await db()
    .insert(identityGates)
    .values({
      identityId: input.identityId,
      resetRequired: true,
      resetGeneration: 1,
      source: input.source,
    })
    .onConflictDoUpdate({
      target: identityGates.identityId,
      set: {
        resetRequired: true,
        resetGeneration: sql<number>`case
          when not ${identityGates.resetRequired} then ${identityGates.resetGeneration} + 1
          else ${identityGates.resetGeneration}
        end`,
        resetCompletedAt: null,
        source: input.source,
        updatedAt: sql`now()`,
      },
    })
}

export async function clearResetGateFromHook(input: {
  eventId: string
  identityId: string
  flowId: string
  sessionId?: string
}): Promise<void> {
  await db().transaction(async (transaction) => {
    const receipt = await transaction
      .insert(hookReceipts)
      .values({
        eventId: input.eventId,
        hookType: 'password_changed',
        identityId: input.identityId,
        flowId: input.flowId,
        sessionId: input.sessionId ?? null,
      })
      .onConflictDoNothing()
      .returning({ eventId: hookReceipts.eventId })
    if (receipt.length === 0) return

    await transaction
      .update(identityGates)
      .set({
        resetRequired: false,
        resetCompletedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(identityGates.identityId, input.identityId), eq(identityGates.resetRequired, true)),
      )
  })
}
