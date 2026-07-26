create schema if not exists auth_control;

create table if not exists auth_control.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists auth_control.identity_gates (
  identity_id uuid primary key,
  reset_required boolean not null default false,
  reset_generation integer not null default 0 check (reset_generation >= 0),
  source text not null,
  reset_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists auth_control.hook_receipts (
  event_id text primary key,
  hook_type text not null,
  identity_id uuid not null,
  flow_id text not null,
  session_id text,
  processed_at timestamptz not null default now()
);

create table if not exists auth_control.invitations (
  id uuid primary key,
  identity_id uuid not null,
  normalized_email text not null,
  product text not null,
  invited_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  recovery_dispatched_at timestamptz not null,
  constraint invitations_email_normalized check (normalized_email = lower(normalized_email))
);

create index if not exists invitations_identity_idx
  on auth_control.invitations (identity_id);
