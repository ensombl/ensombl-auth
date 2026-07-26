#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

require_rule() {
  local rule="$1"
  if ! grep -Fxq "$rule" .dockerignore; then
    echo "Missing required .dockerignore rule: $rule" >&2
    exit 1
  fi
}

for rule in \
  '.env*' \
  '**/.env*' \
  'node_modules/' \
  '**/node_modules/' \
  'build/' \
  '**/build/' \
  '.turbo/' \
  '**/.turbo/' \
  '.git/' \
  '.cache/' \
  '**/.cache/' \
  '**/secrets/' \
  '*.key' \
  '*.pem'
do
  require_rule "$rule"
done

for required_input in \
  package.json \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  .npmrc \
  tsconfig.json \
  turbo.json \
  biome.json \
  apps/control-plane/package.json \
  apps/control-plane/src \
  apps/control-plane/migrations \
  apps/control-plane/scripts
do
  if [[ ! -e "$required_input" ]]; then
    echo "Docker build input is missing: $required_input" >&2
    exit 1
  fi
done

echo "Docker context policy passed"
