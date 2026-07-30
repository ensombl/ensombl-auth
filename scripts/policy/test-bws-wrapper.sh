#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
fixture_path="$repo_root/scripts/policy/fixtures"
wrapper="$repo_root/deploy/bws/with-secrets.sh"
project_id='00000000-0000-0000-0000-000000000001'

PATH="$fixture_path:$PATH" \
  BWS_ACCESS_TOKEN=fixture-access-token \
  BWS_PROJECT_ID="$project_id" \
  BWS_SECRET_MAP='EXPORTED_SECRET=RAW_SECRET AUTHORIZATION=bearer:TOKEN_SECRET' \
  sh "$wrapper" sh -c '
    test "$EXPORTED_SECRET" = "value with spaces and \$dollar"
    test "$AUTHORIZATION" = "Bearer token-value"
    test -z "${BWS_ACCESS_TOKEN+x}"
    test -z "${BWS_PROJECT_ID+x}"
    test -z "${BWS_SECRET_MAP+x}"
  '

env -u BWS_ACCESS_TOKEN -u BWS_PROJECT_ID -u BWS_SECRET_MAP \
  LOCAL_FIXTURE=available \
  sh "$wrapper" sh -c 'test "$LOCAL_FIXTURE" = "available"' \
  2>/dev/null

if PATH="$fixture_path:$PATH" \
  BWS_FIXTURE_DUPLICATE=1 \
  BWS_ACCESS_TOKEN=fixture-access-token \
  BWS_PROJECT_ID="$project_id" \
  BWS_SECRET_MAP='EXPORTED_SECRET=RAW_SECRET' \
  sh "$wrapper" true 2>/dev/null; then
  echo "Duplicate Bitwarden keys must fail closed" >&2
  exit 1
fi

echo "BWS runtime wrapper passed"
