#!/bin/sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/../.." && pwd)"
validation_cipher_secret='validation-cipher-secret-32-byte' # gitleaks:allow

if [ "$#" -eq 0 ]; then
  set -- --quiet
fi

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
  INVITATION_RECONCILER_SECRET=validation-only-reconciler-secret \
  FREIGHTCLAIMS_STAGING_AUTHORIZATION_DECISION_SECRET=validation-only-freightclaims-staging-authorization \
  FREIGHTCLAIMS_PRODUCTION_AUTHORIZATION_DECISION_SECRET=validation-only-freightclaims-production-authorization \
  FREIGHTCLAIMS_STAGING_IDENTITY_MANAGEMENT_SECRET=validation-only-freightclaims-staging-identity-management \
  FREIGHTCLAIMS_PRODUCTION_IDENTITY_MANAGEMENT_SECRET=validation-only-freightclaims-production-identity-management \
  FREIGHTCLAIMS_STAGING_IDENTITY_MIGRATION_SECRET=validation-only-freightclaims-staging-identity-migration \
  FREIGHTCLAIMS_PRODUCTION_IDENTITY_MIGRATION_SECRET=validation-only-freightclaims-production-identity-migration \
  FREIGHTCLAIMS_STAGING_HYDRA_CLIENT_SECRET=validation-only-freightclaims-staging \
  FREIGHTCLAIMS_PRODUCTION_HYDRA_CLIENT_SECRET=validation-only-freightclaims-production \
  SMTP_CONNECTION_URI=smtps://validation:validation@example.invalid:465/ \
  SMTP_FROM_ADDRESS=no-reply@example.invalid \
  SMTP_FROM_NAME=Validation \
  docker compose \
    --file "$repo_root/deploy/dokploy/compose.yml" \
    config "$@"
