#!/bin/sh
set -eu

: "${HYDRA_ADMIN_URL:?HYDRA_ADMIN_URL is required}"
: "${HYDRA_CLIENT_ID:?HYDRA_CLIENT_ID is required}"
: "${HYDRA_CLIENT_SECRET:?HYDRA_CLIENT_SECRET is required}"
: "${FREIGHTCLAIMS_BASE_URL:?FREIGHTCLAIMS_BASE_URL is required}"

case "$HYDRA_ADMIN_URL" in
  http://* | https://*) ;;
  *) printf '%s\n' 'HYDRA_ADMIN_URL must be an HTTP(S) URL' >&2; exit 1 ;;
esac
case "$HYDRA_ADMIN_URL" in
  *[!A-Za-z0-9:/._-]*) printf '%s\n' 'HYDRA_ADMIN_URL contains unsupported characters' >&2; exit 1 ;;
esac
case "$HYDRA_CLIENT_ID" in
  '' | *[!A-Za-z0-9._-]*) printf '%s\n' 'HYDRA_CLIENT_ID contains unsupported characters' >&2; exit 1 ;;
esac
if [ "${#HYDRA_CLIENT_SECRET}" -lt 32 ]; then
  printf '%s\n' 'HYDRA_CLIENT_SECRET must contain at least 32 characters' >&2
  exit 1
fi
case "$HYDRA_CLIENT_SECRET" in
  *[!A-Za-z0-9_-]*) printf '%s\n' 'HYDRA_CLIENT_SECRET must be URL-safe' >&2; exit 1 ;;
esac
case "$FREIGHTCLAIMS_BASE_URL" in
  http://localhost:* | https://*) ;;
  *) printf '%s\n' 'FREIGHTCLAIMS_BASE_URL must be HTTPS (or localhost for development)' >&2; exit 1 ;;
esac
case "$FREIGHTCLAIMS_BASE_URL" in
  *[!A-Za-z0-9:/._-]*) printf '%s\n' 'FREIGHTCLAIMS_BASE_URL contains unsupported characters' >&2; exit 1 ;;
esac

write_client_document() {
  printf '%s\n' \
    '{' \
    "  \"client_id\": \"$HYDRA_CLIENT_ID\"," \
    "  \"client_secret\": \"$HYDRA_CLIENT_SECRET\"," \
    '  "client_name": "FreightClaims web BFF",' \
    '  "grant_types": ["authorization_code", "refresh_token"],' \
    '  "response_types": ["code"],' \
    '  "scope": "openid offline_access email profile",' \
    '  "audience": ["freightclaims"],' \
    "  \"redirect_uris\": [\"${FREIGHTCLAIMS_BASE_URL%/}/auth/callback\"]," \
    "  \"post_logout_redirect_uris\": [\"${FREIGHTCLAIMS_BASE_URL%/}/\"]," \
    '  "token_endpoint_auth_method": "client_secret_basic",' \
    '  "metadata": {"ensombl_product": "freightclaims", "first_party": true}' \
    '}'
}

if hydra get oauth2-client "$HYDRA_CLIENT_ID" \
  --endpoint "$HYDRA_ADMIN_URL" >/dev/null 2>&1; then
  write_client_document |
    hydra update oauth2-client "$HYDRA_CLIENT_ID" \
      --endpoint "$HYDRA_ADMIN_URL" \
      --file /dev/stdin >/dev/null
else
  write_client_document |
    wget -q -O - \
      --header "Content-Type: application/json" \
      --post-file=/dev/stdin \
      "${HYDRA_ADMIN_URL%/}/admin/clients" >/dev/null
fi

echo "Hydra client is ready: $HYDRA_CLIENT_ID"
