alter table auth_control.identity_import_entries
  drop constraint if exists identity_import_entries_identity_id_key;

create index if not exists identity_import_entries_identity_id_idx
  on auth_control.identity_import_entries (identity_id);

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
    requested_source in ('freightclaims-fc-stage', 'freightclaims-fc-prod')
    and exists (
      select 1
      from auth_control.identity_import_entries as entry
      where entry.identity_id = requested_identity_id
        and entry.source_user_id = requested_source_user_id
        and entry.email_sha256 = requested_email_sha256
        and entry.status = 'completed'
        and entry.source = case requested_source
          when 'freightclaims-fc-stage' then 'freightclaims-fc-prod'
          when 'freightclaims-fc-prod' then 'freightclaims-fc-stage'
        end
    );
$$;

revoke all
  on function auth_control.can_reuse_completed_migrated_identity(uuid, text, text, text)
  from public;
