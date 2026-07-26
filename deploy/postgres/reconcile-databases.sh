#!/bin/sh
set -eu

: "${POSTGRES_USER:=postgres}"
: "${POSTGRES_DB:=postgres}"
: "${POSTGRES_SUPERUSER_PASSWORD:?POSTGRES_SUPERUSER_PASSWORD is required}"
: "${KRATOS_DB_PASSWORD:?KRATOS_DB_PASSWORD is required}"
: "${HYDRA_DB_PASSWORD:?HYDRA_DB_PASSWORD is required}"
: "${KETO_DB_PASSWORD:?KETO_DB_PASSWORD is required}"
: "${AUTH_CONTROL_MIGRATOR_DB_PASSWORD:?AUTH_CONTROL_MIGRATOR_DB_PASSWORD is required}"
: "${AUTH_CONTROL_RUNTIME_DB_PASSWORD:?AUTH_CONTROL_RUNTIME_DB_PASSWORD is required}"
: "${IDENTITY_IMPORT_DB_PASSWORD:?IDENTITY_IMPORT_DB_PASSWORD is required}"
export POSTGRES_USER

psql \
  --no-psqlrc \
  --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<'SQL'
\set QUIET on
\getenv postgres_user POSTGRES_USER
\getenv postgres_password POSTGRES_SUPERUSER_PASSWORD
\getenv kratos_password KRATOS_DB_PASSWORD
\getenv hydra_password HYDRA_DB_PASSWORD
\getenv keto_password KETO_DB_PASSWORD
\getenv migrator_password AUTH_CONTROL_MIGRATOR_DB_PASSWORD
\getenv runtime_password AUTH_CONTROL_RUNTIME_DB_PASSWORD
\getenv import_password IDENTITY_IMPORT_DB_PASSWORD

select format('create role kratos login password %L', :'kratos_password')
where not exists (select from pg_roles where rolname = 'kratos')
\gexec
select format('create role hydra login password %L', :'hydra_password')
where not exists (select from pg_roles where rolname = 'hydra')
\gexec
select format('create role keto login password %L', :'keto_password')
where not exists (select from pg_roles where rolname = 'keto')
\gexec
select 'create role auth_control_owner nologin'
where not exists (select from pg_roles where rolname = 'auth_control_owner')
\gexec
select format(
  'create role auth_control_migrator login password %L',
  :'migrator_password'
)
where not exists (select from pg_roles where rolname = 'auth_control_migrator')
\gexec
select format(
  'create role auth_control_runtime login password %L',
  :'runtime_password'
)
where not exists (select from pg_roles where rolname = 'auth_control_runtime')
\gexec
select format(
  'create role auth_identity_import login password %L',
  :'import_password'
)
where not exists (select from pg_roles where rolname = 'auth_identity_import')
\gexec

select format(
  'alter role %I with superuser createdb createrole inherit login replication bypassrls password %L',
  :'postgres_user',
  :'postgres_password'
)
\gexec
select format(
  'alter role kratos with nosuperuser nocreatedb nocreaterole inherit login noreplication nobypassrls password %L',
  :'kratos_password'
)
\gexec
select format(
  'alter role hydra with nosuperuser nocreatedb nocreaterole inherit login noreplication nobypassrls password %L',
  :'hydra_password'
)
\gexec
select format(
  'alter role keto with nosuperuser nocreatedb nocreaterole inherit login noreplication nobypassrls password %L',
  :'keto_password'
)
\gexec
alter role auth_control_owner
  with nosuperuser nocreatedb nocreaterole inherit nologin noreplication nobypassrls;
select format(
  'alter role auth_control_migrator with nosuperuser nocreatedb nocreaterole noinherit login noreplication nobypassrls password %L',
  :'migrator_password'
)
\gexec
select format(
  'alter role auth_control_runtime with nosuperuser nocreatedb nocreaterole noinherit login noreplication nobypassrls password %L',
  :'runtime_password'
)
\gexec
select format(
  'alter role auth_identity_import with nosuperuser nocreatedb nocreaterole noinherit login noreplication nobypassrls password %L',
  :'import_password'
)
\gexec

grant auth_control_owner to auth_control_migrator;

select 'create database kratos owner kratos'
where not exists (select from pg_database where datname = 'kratos')
\gexec
select 'create database hydra owner hydra'
where not exists (select from pg_database where datname = 'hydra')
\gexec
select 'create database keto owner keto'
where not exists (select from pg_database where datname = 'keto')
\gexec
select 'create database auth_control owner auth_control_owner'
where not exists (select from pg_database where datname = 'auth_control')
\gexec

alter database kratos owner to kratos;
alter database hydra owner to hydra;
alter database keto owner to keto;
alter database auth_control owner to auth_control_owner;

revoke all on database kratos from public;
revoke all on database hydra from public;
revoke all on database keto from public;
revoke all on database auth_control from public;
grant connect on database auth_control
  to auth_control_migrator, auth_control_runtime, auth_identity_import;

alter role auth_control_migrator in database auth_control
  set role = 'auth_control_owner';
alter role auth_control_migrator in database auth_control
  set search_path = 'auth_control', 'public';
alter role auth_control_runtime in database auth_control
  set search_path = 'auth_control', 'public';
alter role auth_identity_import in database auth_control
  set search_path = 'auth_control', 'public';
\set QUIET off
SQL

psql \
  --no-psqlrc \
  --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname auth_control <<'SQL'
\set QUIET on

select 'reassign owned by auth_control to auth_control_owner'
where exists (select from pg_roles where rolname = 'auth_control')
\gexec
select 'alter role auth_control with nologin'
where exists (select from pg_roles where rolname = 'auth_control')
\gexec

create schema if not exists auth_control authorization auth_control_owner;
alter schema auth_control owner to auth_control_owner;
revoke all on schema public from public;
revoke all on schema auth_control from public;
grant usage on schema auth_control
  to auth_control_runtime, auth_identity_import;

alter default privileges for role auth_control_owner in schema auth_control
  revoke all on tables
  from public, auth_control_runtime, auth_identity_import;
alter default privileges for role auth_control_owner in schema auth_control
  revoke all on sequences
  from public, auth_control_runtime, auth_identity_import;
alter default privileges for role auth_control_owner in schema auth_control
  revoke all on functions
  from public, auth_control_runtime, auth_identity_import;
\set QUIET off
SQL

printf '%s\n' 'PostgreSQL databases, roles, and desired credentials reconciled.'
