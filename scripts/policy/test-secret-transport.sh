#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

manifest_secrets="$(jq -r '.requiredSecrets[]' deploy/secrets/manifest.json | sort -u)"
bootstrap_environment="$(
  jq -r \
    '.hostedBootstrapEnvironment.secret[], .hostedBootstrapEnvironment.nonSecret[]' \
    deploy/secrets/manifest.json |
    sort -u
)"
compose_interpolation="$(
  grep -oE '\$\{[A-Z0-9_]+' deploy/dokploy/compose.yml |
    sed 's/^${//' |
    sort -u
)"
rendered_compose="$(./scripts/policy/validate-dokploy-compose.sh --format json)"
mapped_secrets="$(
  jq -r '
    [
      .services[]
      | .environment.BWS_SECRET_MAP
      | split(" ")[]
      | select(length > 0)
      | split("=")[1]
      | sub("^bearer:"; "")
    ]
    | unique[]
  ' <<<"$rendered_compose"
)"
egressless_bws_services="$(
  jq -r '
    . as $compose
    | .services
    | to_entries[]
    | select(.value.environment.BWS_SECRET_MAP? != null)
    | . as $service
    | [
        $service.value.networks
        | keys[]
        | select(($compose.networks[.].internal // false) == false)
      ]
    | select(length == 0)
    | $service.key
  ' <<<"$rendered_compose"
)"

if ! diff -u \
  <(printf '%s\n' "$manifest_secrets") \
  <(printf '%s\n' "$mapped_secrets"); then
  echo "Hosted BWS secret mappings and the Bitwarden manifest differ" >&2
  exit 1
fi

if ! diff -u \
  <(printf '%s\n' "$bootstrap_environment") \
  <(printf '%s\n' "$compose_interpolation"); then
  echo "Dokploy must receive only the BWS token and non-secret project ID" >&2
  exit 1
fi

if [ -n "$egressless_bws_services" ]; then
  printf 'BWS consumers require outbound HTTPS but have only internal networks:\n%s\n' \
    "$egressless_bws_services" >&2
  exit 1
fi

if rg -n 'DOKPLOY_(API_KEY|AUTH_TOKEN|URL)' deploy/dokploy/compose.yml; then
  echo "Dokploy administration credentials are forbidden in runtime Compose" >&2
  exit 1
fi

if rg -n --glob '*.sh' -- '--(access-token|secret)([ =]|$)' deploy scripts; then
  echo "A secret-bearing command-line flag is forbidden" >&2
  exit 1
fi

if rg -ni --glob '*.sh' -- '--set[ =][^ ]*(password|secret)' deploy scripts; then
  echo "Password/secret psql variables must not be transported in argv" >&2
  exit 1
fi

if ! rg -q -- '--file /dev/stdin' deploy/ory/hydra/bootstrap-client.sh; then
  echo "Hydra client update must receive its document through stdin" >&2
  exit 1
fi

if ! rg -q -- '--post-file=/dev/stdin' deploy/ory/hydra/bootstrap-client.sh; then
  echo "Hydra client creation must receive its document through stdin" >&2
  exit 1
fi

if rg -n 'process\\.env\\.DATABASE_URL|environment\\.DATABASE_URL' \
  apps/control-plane/scripts/migrate.ts \
  apps/control-plane/scripts/migration-database-url.ts; then
  echo "The migrator must not consume the runtime DATABASE_URL" >&2
  exit 1
fi

if ! rg -q \
  'AUTH_CONTROL_MIGRATION_URL=AUTH_CONTROL_DATABASE_URL' \
  deploy/dokploy/compose.yml; then
  echo "The hosted migration job must use the native auth-control database URL" >&2
  exit 1
fi

if ! rg -q 'unset BWS_ACCESS_TOKEN BWS_PROJECT_ID BWS_SECRET_MAP secrets_json' \
  deploy/bws/with-secrets.sh; then
  echo "The runtime wrapper must remove its Bitwarden bootstrap credentials" >&2
  exit 1
fi

for dockerfile in \
  apps/control-plane/Dockerfile \
  deploy/ory/kratos/Dockerfile \
  deploy/ory/hydra/Dockerfile \
  deploy/ory/keto/Dockerfile
do
  if ! rg -q 'COPY --from=bws /out/bws /usr/local/bin/bws' "$dockerfile"; then
    echo "Hosted image does not contain the verified BWS binary: $dockerfile" >&2
    exit 1
  fi

  if ! awk '
    /^FROM / { has_ca = 0 }
    /ca-certificates/ { has_ca = 1 }
    END { exit !has_ca }
  ' "$dockerfile"; then
    echo "Hosted runtime image does not contain CA certificates for BWS: $dockerfile" >&2
    exit 1
  fi
done

echo "Secret transport and Bitwarden manifest policy passed"
