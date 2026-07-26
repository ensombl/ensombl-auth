alter table auth_control.invitations
  alter column identity_id drop not null,
  alter column recovery_dispatched_at drop not null,
  add column idempotency_key text,
  add column request_fingerprint char(64),
  add column state text,
  add column admission_preexisting boolean not null default false,
  add column attempt_count integer not null default 0,
  add column processing_token uuid,
  add column processing_started_at timestamptz,
  add column activation_requested_at timestamptz,
  add column activated_at timestamptz,
  add column expired_at timestamptz,
  add column last_error_code text,
  add column updated_at timestamptz not null default now();

update auth_control.invitations
set idempotency_key = 'legacy:' || id::text,
    request_fingerprint = repeat('0', 64),
    state = 'dispatched'
where idempotency_key is null;

alter table auth_control.invitations
  alter column idempotency_key set not null,
  alter column request_fingerprint set not null,
  alter column state set not null,
  add constraint invitations_state_valid check (
    state in (
      'pending_identity',
      'identity_failed',
      'pending_dispatch',
      'dispatch_failed',
      'dispatched',
      'activation_pending',
      'activation_failed',
      'active',
      'expired'
    )
  ),
  add constraint invitations_attempt_count_valid check (attempt_count >= 0),
  add constraint invitations_processing_pair check (
    (processing_token is null) = (processing_started_at is null)
  );

create unique index invitations_idempotency_key_idx
  on auth_control.invitations (idempotency_key);

create index invitations_pending_activation_idx
  on auth_control.invitations (identity_id, product, state)
  where state in ('dispatched', 'activation_pending', 'activation_failed');

create table auth_control.invitation_events (
  event_id text not null,
  invitation_id uuid not null references auth_control.invitations (id),
  event_type text not null,
  outcome text not null,
  flow_id text,
  detail_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, invitation_id)
);
