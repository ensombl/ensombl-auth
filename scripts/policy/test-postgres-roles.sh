#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

docker compose up -d --wait postgres >/dev/null
docker compose run --rm postgres-reconcile >/dev/null
env -u AUTH_CONTROL_MIGRATION_URL \
  NODE_ENV=development \
  DATABASE_URL='postgres://auth_control_runtime:must-be-ignored@127.0.0.1:1/unrelated' \
  pnpm db:migrate >/dev/null

docker compose exec -T postgres \
  psql --no-psqlrc --set ON_ERROR_STOP=1 --username postgres --dbname auth_control <<'SQL'
do $policy$
begin
  if (
    select count(*)
    from pg_roles
    where rolname = 'auth_control_owner'
      and not rolcanlogin
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
  ) <> 1 then
    raise exception 'auth_control_owner is not a constrained NOLOGIN role';
  end if;

  if (
    select count(*)
    from pg_roles
    where rolname in (
      'auth_control_migrator',
      'auth_control_runtime',
      'auth_identity_import'
    )
      and rolcanlogin
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
      and not rolreplication
      and not rolbypassrls
  ) <> 3 then
    raise exception 'auth-control login roles are not constrained';
  end if;

  if exists (
    select 1
    from pg_roles
    where rolname = 'auth_control'
      and rolcanlogin
  ) then
    raise exception 'legacy auth_control role can still log in';
  end if;

  if (
    select datdba <> 'auth_control_owner'::regrole
    from pg_database
    where datname = 'auth_control'
  ) then
    raise exception 'auth_control database owner is incorrect';
  end if;

  if not (
    has_database_privilege('auth_control_migrator', 'auth_control', 'CONNECT')
    and has_database_privilege('auth_control_runtime', 'auth_control', 'CONNECT')
    and has_database_privilege('auth_identity_import', 'auth_control', 'CONNECT')
  ) then
    raise exception 'an auth-control login role cannot connect to its database';
  end if;

  if (
    has_database_privilege('auth_control_runtime', 'auth_control', 'CREATE')
    or has_database_privilege('auth_control_runtime', 'auth_control', 'TEMPORARY')
    or has_database_privilege('auth_identity_import', 'auth_control', 'CREATE')
    or has_database_privilege('auth_identity_import', 'auth_control', 'TEMPORARY')
  ) then
    raise exception 'a runtime/import role has excessive database privileges';
  end if;

  if exists (
    select 1
    from pg_tables
    where schemaname = 'auth_control'
      and tableowner <> 'auth_control_owner'
  ) then
    raise exception 'an auth_control table is not owner-owned';
  end if;

  if exists (
    select 1
    from pg_default_acl
    where defaclrole = 'auth_control_owner'::regrole
      and (
        coalesce(array_to_string(defaclacl, ','), '') like '%auth_control_runtime%'
        or coalesce(array_to_string(defaclacl, ','), '') like '%auth_identity_import%'
      )
  ) then
    raise exception 'sensitive runtime/import privileges remain in owner default ACLs';
  end if;

  if not (
    has_table_privilege('auth_control_runtime', 'auth_control.identity_gates', 'SELECT')
    and has_table_privilege('auth_control_runtime', 'auth_control.identity_gates', 'INSERT')
    and has_table_privilege('auth_control_runtime', 'auth_control.identity_gates', 'UPDATE')
    and has_table_privilege('auth_control_runtime', 'auth_control.hook_receipts', 'SELECT')
    and has_table_privilege('auth_control_runtime', 'auth_control.hook_receipts', 'INSERT')
    and has_table_privilege('auth_control_runtime', 'auth_control.invitations', 'SELECT')
    and has_table_privilege('auth_control_runtime', 'auth_control.invitations', 'INSERT')
    and has_table_privilege('auth_control_runtime', 'auth_control.invitations', 'UPDATE')
    and has_table_privilege('auth_control_runtime', 'auth_control.invitation_events', 'SELECT')
    and has_table_privilege('auth_control_runtime', 'auth_control.invitation_events', 'INSERT')
    and has_table_privilege('auth_control_runtime', 'auth_control.invitation_events', 'UPDATE')
  ) then
    raise exception 'runtime role is missing an application privilege';
  end if;

  if (
    has_table_privilege('auth_control_runtime', 'auth_control.identity_gates', 'DELETE')
    or has_table_privilege('auth_control_runtime', 'auth_control.hook_receipts', 'UPDATE')
    or has_table_privilege('auth_control_runtime', 'auth_control.hook_receipts', 'DELETE')
    or has_table_privilege('auth_control_runtime', 'auth_control.invitations', 'DELETE')
    or has_table_privilege('auth_control_runtime', 'auth_control.invitation_events', 'DELETE')
    or has_table_privilege('auth_control_runtime', 'auth_control.schema_migrations', 'SELECT')
    or has_table_privilege('auth_control_runtime', 'auth_control.identity_import_batches', 'SELECT')
    or has_table_privilege('auth_control_runtime', 'auth_control.identity_import_entries', 'SELECT')
    or has_schema_privilege('auth_control_runtime', 'auth_control', 'CREATE')
  ) then
    raise exception 'runtime role has an excessive privilege';
  end if;

  if not (
    has_table_privilege('auth_identity_import', 'auth_control.identity_import_batches', 'SELECT')
    and has_table_privilege('auth_identity_import', 'auth_control.identity_import_batches', 'INSERT')
    and has_table_privilege('auth_identity_import', 'auth_control.identity_import_batches', 'UPDATE')
    and has_table_privilege('auth_identity_import', 'auth_control.identity_import_entries', 'SELECT')
    and has_table_privilege('auth_identity_import', 'auth_control.identity_import_entries', 'INSERT')
    and has_table_privilege('auth_identity_import', 'auth_control.identity_import_entries', 'UPDATE')
    and has_function_privilege(
      'auth_identity_import',
      'auth_control.require_migrated_identity_reset(uuid,text)',
      'EXECUTE'
    )
  ) then
    raise exception 'identity importer is missing a required privilege';
  end if;

  if (
    has_table_privilege('auth_identity_import', 'auth_control.identity_gates', 'SELECT')
    or has_table_privilege('auth_identity_import', 'auth_control.identity_gates', 'INSERT')
    or has_table_privilege('auth_identity_import', 'auth_control.identity_gates', 'UPDATE')
    or has_table_privilege('auth_identity_import', 'auth_control.identity_gates', 'DELETE')
    or has_table_privilege('auth_identity_import', 'auth_control.invitations', 'SELECT')
    or has_table_privilege('auth_identity_import', 'auth_control.schema_migrations', 'SELECT')
    or has_table_privilege('auth_identity_import', 'auth_control.identity_import_batches', 'DELETE')
    or has_table_privilege('auth_identity_import', 'auth_control.identity_import_entries', 'DELETE')
    or has_schema_privilege('auth_identity_import', 'auth_control', 'CREATE')
  ) then
    raise exception 'identity importer has an excessive privilege';
  end if;
end
$policy$;
SQL

effective_migrator="$(
  docker compose exec -T \
    -e PGPASSWORD=auth_control_migrator_dev \
    postgres \
    psql --no-psqlrc --tuples-only --no-align \
      --host 127.0.0.1 \
      --username auth_control_migrator \
      --dbname auth_control \
      --command 'select current_user'
)"
if [[ "$effective_migrator" != "auth_control_owner" ]]; then
  echo "Migrator did not assume the owner role" >&2
  exit 1
fi

echo "PostgreSQL ownership and least-privilege role policy passed"
