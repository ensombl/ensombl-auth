import postgres from 'postgres'
import { config } from './config'

let client: ReturnType<typeof postgres> | undefined

export function db(): ReturnType<typeof postgres> {
  client ??= postgres(config().DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
    transform: {
      undefined: null,
    },
  })
  return client
}

export async function isResetRequired(identityId: string): Promise<boolean> {
  const rows = await db()<Array<{ reset_required: boolean }>>`
    select reset_required
    from auth_control.identity_gates
    where identity_id = ${identityId}::uuid
  `
  return rows[0]?.reset_required ?? false
}

export async function setResetGate(input: { identityId: string; source: string }): Promise<void> {
  await db()`
    insert into auth_control.identity_gates (
      identity_id,
      reset_required,
      reset_generation,
      source,
      updated_at
    )
    values (
      ${input.identityId}::uuid,
      true,
      1,
      ${input.source},
      now()
    )
    on conflict (identity_id) do update
    set reset_required = excluded.reset_required,
        reset_generation = case
          when not auth_control.identity_gates.reset_required
            then auth_control.identity_gates.reset_generation + 1
          else auth_control.identity_gates.reset_generation
        end,
        reset_completed_at = null,
        source = excluded.source,
        updated_at = now()
  `
}

export async function clearResetGateFromHook(input: {
  eventId: string
  identityId: string
  flowId: string
  sessionId?: string
}): Promise<void> {
  await db().begin(async (transaction) => {
    const receipt = await transaction`
      insert into auth_control.hook_receipts (
        event_id,
        hook_type,
        identity_id,
        flow_id,
        session_id
      )
      values (
        ${input.eventId},
        'password_changed',
        ${input.identityId}::uuid,
        ${input.flowId},
        ${input.sessionId ?? null}
      )
      on conflict (event_id) do nothing
      returning event_id
    `
    if (receipt.length === 0) return

    await transaction`
      update auth_control.identity_gates
      set reset_required = false,
          reset_completed_at = now(),
          updated_at = now()
      where identity_id = ${input.identityId}::uuid
        and reset_required
    `
  })
}
