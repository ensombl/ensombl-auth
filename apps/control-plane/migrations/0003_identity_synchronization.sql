create table if not exists auth_control.identity_sync_batches (
  request_sha256 text primary key
    check (request_sha256 ~ '^[0-9a-f]{64}$'),
  client_id text not null,
  source text not null,
  source_snapshot text not null,
  expected_count integer not null
    check (expected_count between 1 and 500),
  status text not null
    check (status in ('running', 'completed', 'failed')),
  response jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error_code text,
  check (
    (status = 'completed' and completed_at is not null and response is not null
      and last_error_code is null)
    or status <> 'completed'
  )
);

create table if not exists auth_control.identity_source_aliases (
  source text not null,
  source_user_id text not null,
  identity_id uuid not null,
  email_sha256 text not null
    check (email_sha256 ~ '^[0-9a-f]{64}$'),
  admission_scope text not null,
  state text not null
    check (state in ('active', 'revoked')),
  first_snapshot text not null,
  last_snapshot text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source, source_user_id)
);

create index if not exists identity_source_aliases_identity_idx
  on auth_control.identity_source_aliases (identity_id);

create index if not exists identity_source_aliases_counterpart_idx
  on auth_control.identity_source_aliases (source_user_id, email_sha256, source);

create table if not exists auth_control.identity_source_memberships (
  source text not null,
  source_user_id text not null,
  admission_scope text not null,
  tenant_id text not null
    check (length(tenant_id) between 1 and 200),
  identity_id uuid not null,
  role text not null
    check (role ~ '^[a-z][a-z0-9_-]{0,63}$'),
  last_snapshot text not null,
  updated_at timestamptz not null default now(),
  primary key (source, source_user_id, admission_scope, tenant_id),
  foreign key (source, source_user_id)
    references auth_control.identity_source_aliases (source, source_user_id)
    on delete restrict
);

create index if not exists identity_source_memberships_identity_idx
  on auth_control.identity_source_memberships (identity_id, admission_scope);
