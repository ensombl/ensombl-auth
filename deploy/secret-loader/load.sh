#!/bin/sh
set -eu

: "${BWS_ACCESS_TOKEN:?BWS_ACCESS_TOKEN is required}"
: "${BWS_PROJECT_ID:?BWS_PROJECT_ID is required}"
: "${ZITADEL_SECRET_DIRECTORY:=/run/ensombl-auth}"

umask 077
mkdir -p "$ZITADEL_SECRET_DIRECTORY"

attempt=1
delay=1
while :; do
  if secrets_json="$(bws secret list "$BWS_PROJECT_ID" --output json --color no)"; then
    break
  fi
  if [ "$attempt" -ge 6 ]; then
    printf 'Unable to load Bitwarden secrets after %s attempts\n' "$attempt" >&2
    exit 1
  fi
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
done

secret() {
  key="$1"
  count="$(
    printf '%s' "$secrets_json" |
      jq --raw-output --arg key "$key" '[.[] | select(.key == $key)] | length'
  )"
  if [ "$count" != "1" ]; then
    printf 'Expected exactly one Bitwarden secret named %s; found %s\n' "$key" "$count" >&2
    exit 1
  fi
  printf '%s' "$secrets_json" |
    jq --exit-status --raw-output --arg key "$key" '[.[] | select(.key == $key)][0].value'
}

masterkey="$(secret ZITADEL_MASTERKEY)"
database_url="$(secret ZITADEL_DATABASE_URL)"
initial_admin_password="$(secret ZITADEL_INITIAL_ADMIN_PASSWORD)"
resend_api_key="$(secret RESEND_API_KEY)"

if [ "$(printf '%s' "$masterkey" | wc -c | tr -d ' ')" != "32" ]; then
  printf '%s\n' 'ZITADEL_MASTERKEY must contain exactly 32 bytes' >&2
  exit 1
fi

printf '%s' "$masterkey" >"$ZITADEL_SECRET_DIRECTORY/masterkey"
jq -n \
  --arg databaseUrl "$database_url" \
  --arg resendApiKey "$resend_api_key" \
  '{
    Database: {Postgres: {DSN: $databaseUrl}},
    DefaultInstance: {
      DomainPolicy: {SMTPSenderAddressMatchesInstanceDomain: false},
      SMTPConfiguration: {
        SMTP: {
          Host: "smtp.resend.com:587",
          PlainAuth: {
            User: "resend",
            Password: $resendApiKey
          }
        },
        TLS: true,
        From: "noreply@notifications.ensombl.io",
        FromName: "Ensombl",
        ReplyToAddress: "noreply@notifications.ensombl.io"
      }
    }
  }' >"$ZITADEL_SECRET_DIRECTORY/config.json"

jq -n \
  --arg initialAdminPassword "$initial_admin_password" \
  '{
    FirstInstance: {
      Org: {
        Human: {Password: $initialAdminPassword},
        Machine: {Pat: {ExpirationDate: "2099-01-01T00:00:00Z"}},
        LoginClient: {Pat: {ExpirationDate: "2099-01-01T00:00:00Z"}}
      }
    }
  }' >"$ZITADEL_SECRET_DIRECTORY/steps.yaml"

unset BWS_ACCESS_TOKEN BWS_PROJECT_ID secrets_json masterkey database_url initial_admin_password resend_api_key
printf '%s\n' 'ZITADEL runtime secrets loaded'
