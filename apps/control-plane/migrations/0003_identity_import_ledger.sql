create table if not exists auth_control.identity_import_batches (
  manifest_sha256 text primary key
    check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  source text not null,
  source_snapshot text not null,
  expected_count integer not null
    check (expected_count between 1 and 500),
  status text not null
    check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error_code text,
  check (
    (status = 'completed' and completed_at is not null and last_error_code is null)
    or status <> 'completed'
  )
);

create table if not exists auth_control.identity_import_entries (
  source text not null,
  source_user_id text not null,
  manifest_sha256 text not null
    references auth_control.identity_import_batches (manifest_sha256),
  identity_id uuid,
  email_sha256 text not null
    check (email_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null
    check (
      status in (
        'started',
        'identity_created',
        'reset_gated',
        'products_granted',
        'identity_activated',
        'completed'
      )
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (source, source_user_id),
  unique (identity_id),
  check (
    (status = 'completed' and identity_id is not null and completed_at is not null)
    or status <> 'completed'
  )
);

create index if not exists identity_import_entries_manifest_idx
  on auth_control.identity_import_entries (manifest_sha256, status);

create or replace function auth_control.require_migrated_identity_reset(
  requested_identity_id uuid,
  requested_source text
)
returns void
language sql
security definer
set search_path = pg_catalog, auth_control
as $$
  insert into auth_control.identity_gates (
    identity_id,
    reset_required,
    reset_generation,
    source,
    updated_at
  )
  values (
    requested_identity_id,
    true,
    1,
    requested_source,
    now()
  )
  on conflict (identity_id) do update
  set reset_required = true,
      reset_generation = case
        when auth_control.identity_gates.reset_required
          then auth_control.identity_gates.reset_generation
        else auth_control.identity_gates.reset_generation + 1
      end,
      source = excluded.source,
      reset_completed_at = null,
      updated_at = now();
$$;

revoke all on function auth_control.require_migrated_identity_reset(uuid, text)
  from public;
