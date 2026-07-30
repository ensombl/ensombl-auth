#!/bin/sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/../.." && pwd)"
validation_cipher_secret='validation-cipher-secret-32-byte' # gitleaks:allow

if [ "$#" -eq 0 ]; then
  set -- --quiet
fi

exec env \
  KRATOS_DATABASE_URL=postgres://kratos:validation-only@auth-kratos-db:5432/kratos \
  HYDRA_DATABASE_URL=postgres://hydra:validation-only@auth-hydra-db:5432/hydra \
  KETO_DATABASE_URL=postgres://keto:validation-only@auth-keto-db:5432/keto \
  AUTH_CONTROL_DATABASE_URL=postgres://auth_control:validation-only@auth-control-db:5432/auth_control \
  KRATOS_COOKIE_SECRET=validation-only-cookie-secret-32-bytes \
  KRATOS_CIPHER_SECRET="$validation_cipher_secret" \
  HYDRA_SYSTEM_SECRET=validation-only-hydra-system-secret \
  HYDRA_PAIRWISE_SALT=validation-only-pairwise-subject-salt \
  ORY_HOOK_SECRET=validation-only-hook-secret \
  MIGRATION_API_SECRET=validation-only-migration-secret \
  INVITATION_RECONCILER_SECRET=validation-only-reconciler-secret \
  AUTH_COURIER_SECRET=validation-only-auth-courier-secret-that-is-long-enough \
  RESEND_API_KEY=validation-only-resend-api-key \
  FREIGHTCLAIMS_STAGING_AUTHORIZATION_DECISION_SECRET=validation-only-freightclaims-staging-authorization \
  FREIGHTCLAIMS_PRODUCTION_AUTHORIZATION_DECISION_SECRET=validation-only-freightclaims-production-authorization \
  FREIGHTCLAIMS_STAGING_IDENTITY_MANAGEMENT_SECRET=validation-only-freightclaims-staging-identity-management \
  FREIGHTCLAIMS_PRODUCTION_IDENTITY_MANAGEMENT_SECRET=validation-only-freightclaims-production-identity-management \
  FREIGHTCLAIMS_STAGING_IDENTITY_MIGRATION_SECRET=validation-only-freightclaims-staging-identity-migration \
  FREIGHTCLAIMS_PRODUCTION_IDENTITY_MIGRATION_SECRET=validation-only-freightclaims-production-identity-migration \
  FREIGHTCLAIMS_STAGING_HYDRA_CLIENT_SECRET=validation-only-freightclaims-staging \
  FREIGHTCLAIMS_PRODUCTION_HYDRA_CLIENT_SECRET=validation-only-freightclaims-production \
  FREIGHTCHECK_STAGING_AUTHORIZATION_DECISION_SECRET=validation-only-freightcheck-staging-authorization \
  FREIGHTCHECK_PRODUCTION_AUTHORIZATION_DECISION_SECRET=validation-only-freightcheck-production-authorization \
  FREIGHTCHECK_STAGING_IDENTITY_MANAGEMENT_SECRET=validation-only-freightcheck-staging-identity-management \
  FREIGHTCHECK_PRODUCTION_IDENTITY_MANAGEMENT_SECRET=validation-only-freightcheck-production-identity-management \
  FREIGHTCHECK_STAGING_HYDRA_CLIENT_SECRET=validation-only-freightcheck-staging \
  FREIGHTCHECK_PRODUCTION_HYDRA_CLIENT_SECRET=validation-only-freightcheck-production \
  docker compose \
    --file "$repo_root/deploy/dokploy/compose.yml" \
    config "$@"
