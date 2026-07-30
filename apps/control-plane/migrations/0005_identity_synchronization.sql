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
  organization_id uuid not null,
  identity_id uuid not null,
  relation text not null
    check (relation in ('members', 'administrators')),
  last_snapshot text not null,
  updated_at timestamptz not null default now(),
  primary key (source, source_user_id, admission_scope, organization_id),
  foreign key (source, source_user_id)
    references auth_control.identity_source_aliases (source, source_user_id)
    on delete restrict
);

create index if not exists identity_source_memberships_identity_idx
  on auth_control.identity_source_memberships (identity_id, admission_scope);

insert into auth_control.identity_source_aliases (
  source,
  source_user_id,
  identity_id,
  email_sha256,
  admission_scope,
  state,
  first_snapshot,
  last_snapshot,
  created_at,
  updated_at
)
select
  case entry.source
    when 'freightclaims-fc-stage' then 'freightclaims-fc-staging'
    when 'freightclaims-fc-prod' then 'freightclaims-fc-production'
    else entry.source
  end,
  entry.source_user_id,
  entry.identity_id,
  entry.email_sha256,
  case entry.source
    when 'freightclaims-fc-stage' then 'freightclaims:staging'
    when 'freightclaims-fc-staging' then 'freightclaims:staging'
    when 'freightclaims-fc-prod' then 'freightclaims:production'
    when 'freightclaims-fc-production' then 'freightclaims:production'
    else entry.source
  end,
  'active',
  batch.source_snapshot,
  batch.source_snapshot,
  entry.created_at,
  entry.updated_at
from auth_control.identity_import_entries as entry
join auth_control.identity_import_batches as batch
  on batch.manifest_sha256 = entry.manifest_sha256
where entry.status = 'completed'
  and entry.identity_id is not null
on conflict (source, source_user_id) do nothing;

create or replace function auth_control.can_reuse_completed_migrated_identity(
  requested_identity_id uuid,
  requested_source text,
  requested_source_user_id text,
  requested_email_sha256 text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, auth_control
as $$
  select
    requested_source in (
      'freightclaims-fc-staging',
      'freightclaims-fc-production'
    )
    and exists (
      select 1
      from auth_control.identity_import_entries as entry
      where entry.identity_id = requested_identity_id
        and entry.source_user_id = requested_source_user_id
        and entry.email_sha256 = requested_email_sha256
        and entry.status = 'completed'
        and entry.source = any (
          case requested_source
            when 'freightclaims-fc-staging'
              then array['freightclaims-fc-prod', 'freightclaims-fc-production']
            when 'freightclaims-fc-production'
              then array['freightclaims-fc-stage', 'freightclaims-fc-staging']
          end
        )
    );
$$;

revoke all
  on function auth_control.can_reuse_completed_migrated_identity(uuid, text, text, text)
  from public;
