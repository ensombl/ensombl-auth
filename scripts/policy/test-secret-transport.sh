#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

compose_secrets="$(
  grep -oE '\$\{[A-Z0-9_]+:\?Inject [^}]+ from Bitwarden\}' deploy/dokploy/compose.yml |
    sed -E 's/^\$\{([A-Z0-9_]+):.*/\1/' |
    sort -u
)"
manifest_secrets="$(jq -r '.requiredSecrets[]' deploy/secrets/manifest.json | sort -u)"

if ! diff -u \
  <(printf '%s\n' "$manifest_secrets") \
  <(printf '%s\n' "$compose_secrets"); then
  echo "Dokploy secret references and the Bitwarden manifest differ" >&2
  exit 1
fi

if rg -n --glob '*.sh' -- '--secret([ =]|$)' deploy scripts; then
  echo "A secret-bearing command-line flag is forbidden" >&2
  exit 1
fi

if rg -ni --glob '*.sh' -- '--set[ =][^ ]*(password|secret)' deploy scripts; then
  echo "Password/secret psql variables must not be transported in argv" >&2
  exit 1
fi

if ! rg -q -- '--file /dev/stdin' deploy/ory/hydra/bootstrap-client.sh; then
  echo "Hydra client bootstrap must receive its document through stdin" >&2
  exit 1
fi

if ! rg -q '\\getenv .*_password [A-Z0-9_]+_PASSWORD' \
  deploy/postgres/reconcile-databases.sh; then
  echo "PostgreSQL reconcile must load password variables from the environment" >&2
  exit 1
fi

if rg -n 'process\\.env\\.DATABASE_URL|environment\\.DATABASE_URL' \
  apps/control-plane/scripts/migrate.ts \
  apps/control-plane/scripts/migration-database-url.ts; then
  echo "The migrator must not consume the runtime DATABASE_URL" >&2
  exit 1
fi

if ! rg -q \
  'AUTH_CONTROL_MIGRATION_URL: postgres://auth_control_migrator:' \
  deploy/dokploy/compose.yml; then
  echo "The hosted migration job must use its dedicated database URL" >&2
  exit 1
fi

if rg -n -- '--arg (password|password_hash|secret)' deploy/identity-import; then
  echo "Identity material must not be copied into jq command arguments" >&2
  exit 1
fi

if rg -n -- 'credentials_identifier=\$' deploy/identity-import; then
  echo "Identity email must not be copied into curl command arguments" >&2
  exit 1
fi

echo "Secret transport and Bitwarden manifest policy passed"
