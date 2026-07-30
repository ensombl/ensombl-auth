#!/bin/sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/../.." && pwd)"
if [ "$#" -eq 0 ]; then
  set -- --quiet
fi

exec env \
  BWS_ACCESS_TOKEN=validation-only-bws-access-token \
  BWS_PROJECT_ID=00000000-0000-0000-0000-000000000001 \
  docker compose \
    --file "$repo_root/deploy/dokploy/compose.yml" \
    config "$@"
