#!/bin/sh
set -eu

if [ -z "${BWS_ACCESS_TOKEN:-}" ]; then
  exec "$@"
fi

: "${BWS_PROJECT_ID:?BWS_PROJECT_ID is required when BWS_ACCESS_TOKEN is set}"
: "${BWS_SECRET_MAP:?BWS_SECRET_MAP is required when BWS_ACCESS_TOKEN is set}"

if ! printf '%s\n' "$BWS_PROJECT_ID" |
  grep -Eq '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'; then
  printf '%s\n' 'BWS_PROJECT_ID must be a UUID' >&2
  exit 1
fi

secrets_json="$(
  bws secret list "$BWS_PROJECT_ID" \
    --output json \
    --color no
)"

for mapping in $BWS_SECRET_MAP; do
  target="${mapping%%=*}"
  source_spec="${mapping#*=}"
  prefix=''

  case "$source_spec" in
    bearer:*)
      source="${source_spec#bearer:}"
      prefix='Bearer '
      ;;
    *)
      source="$source_spec"
      ;;
  esac

  case "$target" in
    '' | *[!A-Z0-9_]*)
      printf 'Invalid BWS secret mapping: %s\n' "$mapping" >&2
      exit 1
      ;;
  esac
  case "$source" in
    '' | *[!A-Z0-9_]*)
      printf 'Invalid BWS secret mapping: %s\n' "$mapping" >&2
      exit 1
      ;;
  esac

  match_count="$(
    printf '%s' "$secrets_json" |
      jq --raw-output --arg key "$source" \
        '[.[] | select(.key == $key)] | length'
  )"
  if [ "$match_count" != '1' ]; then
    printf 'Expected exactly one Bitwarden secret named %s; found %s\n' \
      "$source" "$match_count" >&2
    exit 1
  fi

  value="$(
    printf '%s' "$secrets_json" |
      jq --exit-status --raw-output --arg key "$source" \
        '[.[] | select(.key == $key)][0].value'
  )"
  export "$target=${prefix}${value}"
done

unset BWS_ACCESS_TOKEN BWS_PROJECT_ID BWS_SECRET_MAP secrets_json
exec "$@"
