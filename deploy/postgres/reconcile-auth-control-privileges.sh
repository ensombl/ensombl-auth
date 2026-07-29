#!/bin/sh
set -eu

: "${POSTGRES_USER:=postgres}"

psql \
  --no-psqlrc \
  --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname auth_control <<'SQL'
\set QUIET on

revoke all on all tables in schema auth_control
  from public, auth_control_runtime, auth_identity_import;
revoke all on all sequences in schema auth_control
  from public, auth_control_runtime, auth_identity_import;
revoke all on all functions in schema auth_control
  from public, auth_control_runtime, auth_identity_import;

select format(
  'grant select, insert, update on table auth_control.%I to auth_control_runtime',
  table_name
)
from information_schema.tables
where table_schema = 'auth_control'
  and table_name in (
    'identity_gates',
    'identity_source_aliases',
    'identity_source_memberships',
    'identity_sync_batches',
    'invitations',
    'invitation_events'
  )
\gexec

grant delete on table auth_control.identity_source_memberships
  to auth_control_runtime;

select format(
  'grant select, insert on table auth_control.%I to auth_control_runtime',
  table_name
)
from information_schema.tables
where table_schema = 'auth_control'
  and table_name = 'hook_receipts'
\gexec

select format(
  'grant select, insert, update on table auth_control.%I to auth_identity_import',
  table_name
)
from information_schema.tables
where table_schema = 'auth_control'
  and table_name in ('identity_import_batches', 'identity_import_entries')
\gexec

grant execute
  on function auth_control.require_migrated_identity_reset(uuid, text)
  to auth_identity_import;
grant execute
  on function auth_control.can_reuse_completed_migrated_identity(uuid, text, text, text)
  to auth_identity_import;
revoke create on schema auth_control from auth_control_runtime, auth_identity_import;
\set QUIET off
SQL

printf '%s\n' 'Auth-control runtime and identity-import privileges reconciled.'
