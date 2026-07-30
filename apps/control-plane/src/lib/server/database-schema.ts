import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const invitationStates = [
  'pending_identity',
  'identity_failed',
  'pending_dispatch',
  'dispatch_failed',
  'dispatched',
  'activation_pending',
  'activation_failed',
  'active',
  'expired',
] as const

export type InvitationState = (typeof invitationStates)[number]

const timestampWithTimezone = (name: string) =>
  timestamp(name, { mode: 'date', withTimezone: true })

export const identityGates = pgTable(
  'identity_gates',
  {
    identityId: uuid('identity_id').primaryKey(),
    resetRequired: boolean('reset_required').notNull().default(false),
    resetGeneration: integer('reset_generation').notNull().default(0),
    source: text('source').notNull(),
    resetCompletedAt: timestampWithTimezone('reset_completed_at'),
    createdAt: timestampWithTimezone('created_at').notNull().defaultNow(),
    updatedAt: timestampWithTimezone('updated_at').notNull().defaultNow(),
  },
  (table) => [check('identity_gates_reset_generation_valid', sql`${table.resetGeneration} >= 0`)],
)

export const hookReceipts = pgTable('hook_receipts', {
  eventId: text('event_id').primaryKey(),
  hookType: text('hook_type').notNull(),
  identityId: uuid('identity_id').notNull(),
  flowId: text('flow_id').notNull(),
  sessionId: text('session_id'),
  processedAt: timestampWithTimezone('processed_at').notNull().defaultNow(),
})

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    identityId: uuid('identity_id'),
    normalizedEmail: text('normalized_email').notNull(),
    product: text('product').notNull(),
    invitedBy: text('invited_by').notNull(),
    createdAt: timestampWithTimezone('created_at').notNull().defaultNow(),
    expiresAt: timestampWithTimezone('expires_at').notNull(),
    recoveryDispatchedAt: timestampWithTimezone('recovery_dispatched_at'),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: char('request_fingerprint', { length: 64 }).notNull(),
    state: text('state').$type<InvitationState>().notNull(),
    admissionPreexisting: boolean('admission_preexisting').notNull().default(false),
    attemptCount: integer('attempt_count').notNull().default(0),
    processingToken: uuid('processing_token'),
    processingStartedAt: timestampWithTimezone('processing_started_at'),
    activationRequestedAt: timestampWithTimezone('activation_requested_at'),
    activatedAt: timestampWithTimezone('activated_at'),
    expiredAt: timestampWithTimezone('expired_at'),
    lastErrorCode: text('last_error_code'),
    updatedAt: timestampWithTimezone('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check(
      'invitations_email_normalized',
      sql`${table.normalizedEmail} = lower(${table.normalizedEmail})`,
    ),
    check(
      'invitations_state_valid',
      sql`${table.state} in ('pending_identity', 'identity_failed', 'pending_dispatch', 'dispatch_failed', 'dispatched', 'activation_pending', 'activation_failed', 'active', 'expired')`,
    ),
    check('invitations_attempt_count_valid', sql`${table.attemptCount} >= 0`),
    check(
      'invitations_processing_pair',
      sql`(${table.processingToken} is null) = (${table.processingStartedAt} is null)`,
    ),
    index('invitations_identity_idx').on(table.identityId),
    uniqueIndex('invitations_idempotency_key_idx').on(table.idempotencyKey),
    index('invitations_pending_activation_idx')
      .on(table.identityId, table.product, table.state)
      .where(sql`${table.state} in ('dispatched', 'activation_pending', 'activation_failed')`),
  ],
)

export const invitationEvents = pgTable(
  'invitation_events',
  {
    eventId: text('event_id').notNull(),
    invitationId: uuid('invitation_id').notNull(),
    eventType: text('event_type').notNull(),
    outcome: text('outcome').notNull(),
    flowId: text('flow_id'),
    detailCode: text('detail_code'),
    createdAt: timestampWithTimezone('created_at').notNull().defaultNow(),
    updatedAt: timestampWithTimezone('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'invitation_events_pk', columns: [table.eventId, table.invitationId] }),
    foreignKey({
      name: 'invitation_events_invitation_fk',
      columns: [table.invitationId],
      foreignColumns: [invitations.id],
    }),
  ],
)

export const identitySyncBatches = pgTable(
  'identity_sync_batches',
  {
    requestSha256: text('request_sha256').primaryKey(),
    clientId: text('client_id').notNull(),
    source: text('source').notNull(),
    sourceSnapshot: text('source_snapshot').notNull(),
    expectedCount: integer('expected_count').notNull(),
    status: text('status').$type<'running' | 'completed' | 'failed'>().notNull(),
    response: jsonb('response').$type<Record<string, unknown>>(),
    startedAt: timestampWithTimezone('started_at').notNull().defaultNow(),
    completedAt: timestampWithTimezone('completed_at'),
    lastErrorCode: text('last_error_code'),
  },
  (table) => [
    check('identity_sync_batches_hash_valid', sql`${table.requestSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'identity_sync_batches_expected_count_valid',
      sql`${table.expectedCount} between 1 and 500`,
    ),
    check(
      'identity_sync_batches_status_valid',
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
    check(
      'identity_sync_batches_completion_valid',
      sql`(
        ${table.status} = 'completed'
        and ${table.completedAt} is not null
        and ${table.response} is not null
        and ${table.lastErrorCode} is null
      ) or ${table.status} <> 'completed'`,
    ),
  ],
)

export const identitySourceAliases = pgTable(
  'identity_source_aliases',
  {
    source: text('source').notNull(),
    sourceUserId: text('source_user_id').notNull(),
    identityId: uuid('identity_id').notNull(),
    emailSha256: text('email_sha256').notNull(),
    admissionScope: text('admission_scope').notNull(),
    state: text('state').$type<'active' | 'revoked'>().notNull(),
    firstSnapshot: text('first_snapshot').notNull(),
    lastSnapshot: text('last_snapshot').notNull(),
    createdAt: timestampWithTimezone('created_at').notNull().defaultNow(),
    updatedAt: timestampWithTimezone('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'identity_source_aliases_pk',
      columns: [table.source, table.sourceUserId],
    }),
    check('identity_source_aliases_email_hash_valid', sql`${table.emailSha256} ~ '^[0-9a-f]{64}$'`),
    check('identity_source_aliases_state_valid', sql`${table.state} in ('active', 'revoked')`),
    index('identity_source_aliases_identity_idx').on(table.identityId),
    index('identity_source_aliases_counterpart_idx').on(
      table.sourceUserId,
      table.emailSha256,
      table.source,
    ),
  ],
)

export const identitySourceMemberships = pgTable(
  'identity_source_memberships',
  {
    source: text('source').notNull(),
    sourceUserId: text('source_user_id').notNull(),
    admissionScope: text('admission_scope').notNull(),
    tenantId: text('tenant_id').notNull(),
    identityId: uuid('identity_id').notNull(),
    role: text('role').notNull(),
    lastSnapshot: text('last_snapshot').notNull(),
    updatedAt: timestampWithTimezone('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'identity_source_memberships_pk',
      columns: [table.source, table.sourceUserId, table.admissionScope, table.tenantId],
    }),
    foreignKey({
      name: 'identity_source_memberships_alias_fk',
      columns: [table.source, table.sourceUserId],
      foreignColumns: [identitySourceAliases.source, identitySourceAliases.sourceUserId],
    }).onDelete('restrict'),
    check(
      'identity_source_memberships_tenant_valid',
      sql`length(${table.tenantId}) between 1 and 200`,
    ),
    check('identity_source_memberships_role_valid', sql`${table.role} ~ '^[a-z][a-z0-9_-]{0,63}$'`),
    index('identity_source_memberships_identity_idx').on(table.identityId, table.admissionScope),
  ],
)
