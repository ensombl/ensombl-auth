#!/bin/sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/../.." && pwd)"
validation_cipher_secret='validation-cipher-secret-32-byte' # gitleaks:allow

exec env \
  POSTGRES_SUPERUSER_PASSWORD=validation-only-postgres-superuser \
  KRATOS_DB_PASSWORD=validation-only-kratos \
  HYDRA_DB_PASSWORD=validation-only-hydra \
  KETO_DB_PASSWORD=validation-only-keto \
  AUTH_CONTROL_MIGRATOR_DB_PASSWORD=validation-only-control-migrator \
  AUTH_CONTROL_RUNTIME_DB_PASSWORD=validation-only-control-runtime \
  IDENTITY_IMPORT_DB_PASSWORD=validation-only-identity-import \
  KRATOS_COOKIE_SECRET=validation-only-cookie-secret-32-bytes \
  KRATOS_CIPHER_SECRET="$validation_cipher_secret" \
  HYDRA_SYSTEM_SECRET=validation-only-hydra-system-secret \
  HYDRA_PAIRWISE_SALT=validation-only-pairwise-subject-salt \
  ORY_HOOK_SECRET=validation-only-hook-secret \
  MIGRATION_API_SECRET=validation-only-migration-secret \
  INVITATION_API_SECRET=validation-only-invitation-secret \
  INVITATION_RECONCILER_SECRET=validation-only-reconciler-secret \
  FREIGHTCLAIMS_HYDRA_CLIENT_SECRET=validation-only-freightclaims-secret \
  SMTP_CONNECTION_URI=smtps://validation:validation@example.invalid:465/ \
  SMTP_FROM_ADDRESS=no-reply@example.invalid \
  SMTP_FROM_NAME=Validation \
  docker compose \
    --file "$repo_root/deploy/dokploy/compose.yml" \
    config --quiet
