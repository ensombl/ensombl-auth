#!/bin/sh
set -eu

: "${PGHOST:?PGHOST is required}"
: "${PGPORT:=5432}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${KRATOS_ADMIN_URL:?KRATOS_ADMIN_URL is required}"
: "${KETO_WRITE_URL:?KETO_WRITE_URL is required}"
: "${IDENTITY_IMPORT_ALLOWED_SOURCE:?IDENTITY_IMPORT_ALLOWED_SOURCE is required}"
: "${IDENTITY_IMPORT_ALLOWED_PRODUCTS:?IDENTITY_IMPORT_ALLOWED_PRODUCTS is required}"
: "${IDENTITY_IMPORT_EXPECTED_SHA256:?IDENTITY_IMPORT_EXPECTED_SHA256 is required}"

work_dir=/work
manifest_path="$work_dir/manifest.json"
response_path="$work_dir/response.json"
request_path="$work_dir/request.json"
query_value_path="$work_dir/query-value"
error_code=unexpected_failure
batch_initialized=false

fail() {
  error_code="$1"
  printf 'Identity import failed: %s\n' "$error_code" >&2
  exit 1
}

mark_batch_failed() {
  exit_status=$?
  trap - EXIT INT TERM
  if [ "$exit_status" -ne 0 ] && [ "$batch_initialized" = true ]; then
    export IMPORT_MANIFEST_SHA256="$manifest_sha256"
    export IMPORT_ERROR_CODE="$error_code"
    psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet <<'SQL' >/dev/null 2>&1 || true
\getenv manifest_sha256 IMPORT_MANIFEST_SHA256
\getenv error_code IMPORT_ERROR_CODE
update auth_control.identity_import_batches
set status = 'failed',
    completed_at = null,
    last_error_code = :'error_code'
where manifest_sha256 = :'manifest_sha256'
  and status <> 'completed';
SQL
  fi
  rm -f "$manifest_path" "$response_path" "$request_path" "$query_value_path"
  exit "$exit_status"
}
trap mark_batch_failed EXIT
trap 'error_code=interrupted; exit 130' INT TERM

maybe_fail_after() {
  step="$1"
  if [ "${IDENTITY_IMPORT_TEST_FAILURE_AFTER:-}" = "$step" ]; then
    fail "injected_$step"
  fi
}

case "$IDENTITY_IMPORT_EXPECTED_SHA256" in
  *[!0-9a-f]*) fail invalid_expected_sha256 ;;
esac
if [ "${#IDENTITY_IMPORT_EXPECTED_SHA256}" -ne 64 ]; then
  fail invalid_expected_sha256
fi

allowed_products_json="$(
  printf '%s' "$IDENTITY_IMPORT_ALLOWED_PRODUCTS" |
    jq -Rc 'split(",") | map(gsub("^\\s+|\\s+$"; ""))'
)"
if ! printf '%s' "$allowed_products_json" |
  jq -e '
    . as $products
    | length >= 1
    and all(.[]; test("^[a-z][a-z0-9-]{0,63}$"))
    and (($products | unique | length) == ($products | length))
  ' >/dev/null; then
  fail invalid_allowed_products
fi

umask 077
head -c 1048577 >"$manifest_path"
manifest_size="$(wc -c <"$manifest_path" | tr -d ' ')"
if [ "$manifest_size" -eq 0 ] || [ "$manifest_size" -gt 1048576 ]; then
  fail invalid_manifest_size
fi

manifest_sha256="$(sha256sum "$manifest_path" | awk '{print $1}')"
if [ "$manifest_sha256" != "$IDENTITY_IMPORT_EXPECTED_SHA256" ]; then
  fail manifest_sha256_mismatch
fi

if ! jq -e \
  --arg allowed_source "$IDENTITY_IMPORT_ALLOWED_SOURCE" \
  --argjson allowed_products "$allowed_products_json" '
  def bounded_string($maximum):
    type == "string" and length >= 1 and length <= $maximum;
  def safe_name:
    if . == null
    then true
    else (
      type == "string"
      and length <= 100
      and (test("[[:cntrl:]]") | not)
    )
    end;
  def valid_argon2id:
    type == "string"
    and test(
      "^\\$argon2id\\$v=19\\$m=65536,t=3,p=1\\$[A-Za-z0-9+/]{22}\\$[A-Za-z0-9+/]{43}$"
    );
  type == "object"
  and ((keys_unsorted - ["schema_version", "source", "source_snapshot", "identities"]) | length == 0)
  and .schema_version == 1
  and .source == $allowed_source
  and (.source | bounded_string(100))
  and (.source_snapshot | bounded_string(200))
  and (.source_snapshot | test("^[A-Za-z0-9._:+-]+$"))
  and (.identities | type == "array" and length >= 1 and length <= 500)
  and (
    all(.identities[];
      type == "object"
      and (
        (keys_unsorted - [
          "source_user_id",
          "email",
          "first_name",
          "last_name",
          "password_hash",
          "reset_required",
          "products"
        ]) | length == 0
      )
      and (.source_user_id | bounded_string(200))
      and (.source_user_id | test("^[A-Za-z0-9._:-]+$"))
      and (.email | bounded_string(320))
      and (.email == (.email | ascii_downcase))
      and (.email | test("^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$"))
      and (.first_name | safe_name)
      and (.last_name | safe_name)
      and (.password_hash | valid_argon2id)
      and .reset_required == true
      and (.products | type == "array" and length >= 1 and length <= 10)
      and (all(.products[]; type == "string" and test("^[a-z][a-z0-9-]{0,63}$")))
      and ((.products | unique | length) == (.products | length))
      and ((.products - $allowed_products) | length == 0)
    )
  )
  and (([.identities[].source_user_id] | unique | length) == (.identities | length))
  and (([.identities[].email] | unique | length) == (.identities | length))
' "$manifest_path" >/dev/null; then
  fail invalid_manifest_schema
fi

source_name="$(jq -r '.source' "$manifest_path")"
source_snapshot="$(jq -r '.source_snapshot' "$manifest_path")"
identity_count="$(jq -r '.identities | length' "$manifest_path")"
export IMPORT_MANIFEST_SHA256="$manifest_sha256"
export IMPORT_SOURCE="$source_name"
export IMPORT_SOURCE_SNAPSHOT="$source_snapshot"
export IMPORT_IDENTITY_COUNT="$identity_count"

batch_record="$(
  psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator '|' <<'SQL'
\getenv manifest_sha256 IMPORT_MANIFEST_SHA256
\getenv source_name IMPORT_SOURCE
\getenv source_snapshot IMPORT_SOURCE_SNAPSHOT
\getenv identity_count IMPORT_IDENTITY_COUNT
insert into auth_control.identity_import_batches (
  manifest_sha256,
  source,
  source_snapshot,
  expected_count,
  status
)
values (
  :'manifest_sha256',
  :'source_name',
  :'source_snapshot',
  :'identity_count'::integer,
  'running'
)
on conflict (manifest_sha256) do nothing;

update auth_control.identity_import_batches
set status = 'running',
    completed_at = null,
    last_error_code = null
where manifest_sha256 = :'manifest_sha256'
  and status <> 'completed';

select status, source, source_snapshot, expected_count
from auth_control.identity_import_batches
where manifest_sha256 = :'manifest_sha256';
SQL
)"
batch_initialized=true

IFS='|' read -r batch_status recorded_source recorded_snapshot recorded_count <<EOF
$batch_record
EOF
if [ "$recorded_source" != "$source_name" ] ||
  [ "$recorded_snapshot" != "$source_snapshot" ] ||
  [ "$recorded_count" != "$identity_count" ]; then
  fail batch_ledger_mismatch
fi
if [ "$batch_status" = completed ]; then
  printf 'Identity import already completed: batch=%s count=%s\n' \
    "$manifest_sha256" "$identity_count"
  exit 0
fi

index=0
imported_count=0
skipped_count=0
while [ "$index" -lt "$identity_count" ]; do
  source_user_id="$(jq -r ".identities[$index].source_user_id" "$manifest_path")"
  email="$(jq -r ".identities[$index].email" "$manifest_path")"
  first_name="$(jq -r ".identities[$index].first_name // empty" "$manifest_path")"
  last_name="$(jq -r ".identities[$index].last_name // empty" "$manifest_path")"
  password_hash="$(jq -r ".identities[$index].password_hash" "$manifest_path")"
  email_sha256="$(printf '%s' "$email" | sha256sum | awk '{print $1}')"
  external_id="$source_name:$source_user_id"
  if [ "${#external_id}" -gt 255 ]; then
    fail external_id_too_long
  fi

  export IMPORT_SOURCE_USER_ID="$source_user_id"
  export IMPORT_EMAIL_SHA256="$email_sha256"
  entry_record="$(
    psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --field-separator '|' <<'SQL'
\getenv source_name IMPORT_SOURCE
\getenv source_user_id IMPORT_SOURCE_USER_ID
\getenv manifest_sha256 IMPORT_MANIFEST_SHA256
\getenv email_sha256 IMPORT_EMAIL_SHA256
insert into auth_control.identity_import_entries (
  source,
  source_user_id,
  manifest_sha256,
  email_sha256,
  status
)
values (
  :'source_name',
  :'source_user_id',
  :'manifest_sha256',
  :'email_sha256',
  'started'
)
on conflict (source, source_user_id) do nothing;

select
  manifest_sha256,
  email_sha256,
  coalesce(identity_id::text, ''),
  status
from auth_control.identity_import_entries
where source = :'source_name'
  and source_user_id = :'source_user_id';
SQL
  )"
  IFS='|' read -r entry_manifest entry_email_sha identity_id entry_status <<EOF
$entry_record
EOF
  if [ "$entry_manifest" != "$manifest_sha256" ] ||
    [ "$entry_email_sha" != "$email_sha256" ]; then
    fail source_identity_collision
  fi
  if [ "$entry_status" = completed ]; then
    skipped_count=$((skipped_count + 1))
    index=$((index + 1))
    continue
  fi

  if [ -z "$identity_id" ]; then
    printf '%s' "$email" >"$query_value_path"
    lookup_status="$(
      curl --silent --output "$response_path" --write-out '%{http_code}' \
        --connect-timeout 5 \
        --max-time 30 \
        --get \
        --data-urlencode "credentials_identifier@$query_value_path" \
        "$KRATOS_ADMIN_URL/admin/identities" 2>/dev/null ||
        printf '000'
    )"
    rm -f "$query_value_path"
    if [ "$lookup_status" != 200 ]; then
      fail kratos_identity_lookup_failed
    fi
    matches="$(jq -r 'length' "$response_path" 2>/dev/null || printf invalid)"
    case "$matches" in
      0)
        export IMPORT_EMAIL="$email"
        export IMPORT_FIRST_NAME="$first_name"
        export IMPORT_LAST_NAME="$last_name"
        export IMPORT_PASSWORD_HASH="$password_hash"
        export IMPORT_EXTERNAL_ID="$external_id"
        jq -n '
          {
            schema_id: "default",
            state: "inactive",
            external_id: env.IMPORT_EXTERNAL_ID,
            traits: {
              email: env.IMPORT_EMAIL,
              name: ({
                first: env.IMPORT_FIRST_NAME,
                last: env.IMPORT_LAST_NAME
              } | with_entries(select(.value != "")))
            },
            credentials: {
              password: {
                config: {
                  hashed_password: env.IMPORT_PASSWORD_HASH
                }
              }
            },
            metadata_admin: {
              migration: {
                source: env.IMPORT_SOURCE,
                source_user_id: env.IMPORT_SOURCE_USER_ID
              }
            }
          }
        ' >"$request_path"
        unset IMPORT_PASSWORD_HASH password_hash
        create_status="$(
          curl --silent --output "$response_path" --write-out '%{http_code}' \
            --connect-timeout 5 \
            --max-time 30 \
            --request POST \
            --header 'content-type: application/json' \
            --data-binary "@$request_path" \
            "$KRATOS_ADMIN_URL/admin/identities" 2>/dev/null ||
            printf '000'
        )"
        rm -f "$request_path"
        if [ "$create_status" != 201 ]; then
          fail kratos_identity_create_failed
        fi
        identity_id="$(jq -r '.id' "$response_path" 2>/dev/null || true)"
        identity_state="$(jq -r '.state' "$response_path" 2>/dev/null || true)"
        if [ "$identity_state" != inactive ]; then
          fail kratos_identity_not_inactive
        fi
        maybe_fail_after after_kratos_create
        ;;
      1)
        found_external_id="$(jq -r '.[0].external_id // ""' "$response_path")"
        if [ "$found_external_id" != "$external_id" ]; then
          fail kratos_email_collision
        fi
        found_email="$(jq -r '.[0].traits.email // ""' "$response_path")"
        if [ "$found_email" != "$email" ]; then
          fail kratos_email_mismatch
        fi
        identity_id="$(jq -r '.[0].id' "$response_path")"
        identity_state="$(jq -r '.[0].state' "$response_path")"
        if [ "$identity_state" != inactive ]; then
          fail kratos_unbound_identity_not_inactive
        fi
        ;;
      *) fail kratos_email_not_unique ;;
    esac
    case "$identity_id" in
      ????????-????-????-????-????????????) ;;
      *) fail kratos_identity_invalid_id ;;
    esac
    export IMPORT_IDENTITY_ID="$identity_id"
    export IMPORT_ENTRY_STATUS=identity_created
    psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet <<'SQL'
\getenv source_name IMPORT_SOURCE
\getenv source_user_id IMPORT_SOURCE_USER_ID
\getenv identity_id IMPORT_IDENTITY_ID
\getenv entry_status IMPORT_ENTRY_STATUS
update auth_control.identity_import_entries
set identity_id = :'identity_id'::uuid,
    status = :'entry_status',
    updated_at = now()
where source = :'source_name'
  and source_user_id = :'source_user_id';
SQL
    maybe_fail_after after_identity_created
  else
    export IMPORT_IDENTITY_ID="$identity_id"
    resume_status="$(
      curl --silent --output "$response_path" --write-out '%{http_code}' \
        --connect-timeout 5 \
        --max-time 30 \
        "$KRATOS_ADMIN_URL/admin/identities/$identity_id" 2>/dev/null ||
        printf '000'
    )"
    if [ "$resume_status" != 200 ]; then
      fail kratos_ledger_identity_missing
    fi
    resumed_id="$(jq -r '.id // ""' "$response_path")"
    resumed_external_id="$(jq -r '.external_id // ""' "$response_path")"
    resumed_email="$(jq -r '.traits.email // ""' "$response_path")"
    resumed_state="$(jq -r '.state // ""' "$response_path")"
    if [ "$resumed_id" != "$identity_id" ] ||
      [ "$resumed_external_id" != "$external_id" ] ||
      [ "$resumed_email" != "$email" ]; then
      fail kratos_ledger_identity_mismatch
    fi
    if [ "$resumed_state" != inactive ] && [ "$resumed_state" != active ]; then
      fail kratos_identity_invalid_state
    fi
  fi

  psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet <<'SQL'
\getenv source_name IMPORT_SOURCE
\getenv source_user_id IMPORT_SOURCE_USER_ID
\getenv identity_id IMPORT_IDENTITY_ID
select auth_control.require_migrated_identity_reset(
  :'identity_id'::uuid,
  :'source_name'
);
update auth_control.identity_import_entries
set status = 'reset_gated',
    updated_at = now()
where source = :'source_name'
  and source_user_id = :'source_user_id'
  and status <> 'completed';
SQL
  maybe_fail_after after_reset_gated

  product_count="$(jq -r ".identities[$index].products | length" "$manifest_path")"
  product_index=0
  while [ "$product_index" -lt "$product_count" ]; do
    product="$(jq -r ".identities[$index].products[$product_index]" "$manifest_path")"
    export IMPORT_PRODUCT="$product"
    jq -n '
      {
        namespace: "Product",
        object: env.IMPORT_PRODUCT,
        relation: "members",
        subject_id: env.IMPORT_IDENTITY_ID
      }
    ' >"$request_path"
    keto_status="$(
      curl --silent --output "$response_path" --write-out '%{http_code}' \
        --connect-timeout 5 \
        --max-time 30 \
        --request PUT \
        --header 'content-type: application/json' \
        --data-binary "@$request_path" \
        "$KETO_WRITE_URL/admin/relation-tuples" 2>/dev/null ||
        printf '000'
    )"
    rm -f "$request_path"
    case "$keto_status" in
      200 | 201 | 204) ;;
      *) fail keto_product_grant_failed ;;
    esac
    product_index=$((product_index + 1))
  done

  psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet <<'SQL'
\getenv source_name IMPORT_SOURCE
\getenv source_user_id IMPORT_SOURCE_USER_ID
update auth_control.identity_import_entries
set status = 'products_granted',
    updated_at = now()
where source = :'source_name'
  and source_user_id = :'source_user_id'
  and status <> 'completed';
SQL
  maybe_fail_after after_products_granted

  printf '%s\n' '[{"op":"replace","path":"/state","value":"active"}]' >"$request_path"
  activate_status="$(
    curl --silent --output "$response_path" --write-out '%{http_code}' \
      --connect-timeout 5 \
      --max-time 30 \
      --request PATCH \
      --header 'content-type: application/json-patch+json' \
      --data-binary "@$request_path" \
      "$KRATOS_ADMIN_URL/admin/identities/$identity_id" 2>/dev/null ||
      printf '000'
  )"
  rm -f "$request_path"
  if [ "$activate_status" != 200 ]; then
    fail kratos_identity_activation_failed
  fi

  psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet <<'SQL'
\getenv source_name IMPORT_SOURCE
\getenv source_user_id IMPORT_SOURCE_USER_ID
update auth_control.identity_import_entries
set status = 'identity_activated',
    updated_at = now()
where source = :'source_name'
  and source_user_id = :'source_user_id'
  and status <> 'completed';
SQL
  maybe_fail_after after_identity_activated

  psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet <<'SQL'
\getenv source_name IMPORT_SOURCE
\getenv source_user_id IMPORT_SOURCE_USER_ID
update auth_control.identity_import_entries
set status = 'completed',
    updated_at = now(),
    completed_at = now()
where source = :'source_name'
  and source_user_id = :'source_user_id';
SQL
  imported_count=$((imported_count + 1))
  index=$((index + 1))
done

batch_status="$(
  psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align <<'SQL'
\getenv manifest_sha256 IMPORT_MANIFEST_SHA256
update auth_control.identity_import_batches as batch
set status = 'completed',
    completed_at = now(),
    last_error_code = null
where batch.manifest_sha256 = :'manifest_sha256'
  and (
    select count(*)
    from auth_control.identity_import_entries as entry
    where entry.manifest_sha256 = batch.manifest_sha256
      and entry.status = 'completed'
  ) = batch.expected_count;
select status
from auth_control.identity_import_batches
where manifest_sha256 = :'manifest_sha256';
SQL
)"
if [ "$batch_status" != completed ]; then
  fail incomplete_batch
fi

printf 'Identity import completed: batch=%s imported=%s skipped=%s total=%s\n' \
  "$manifest_sha256" "$imported_count" "$skipped_count" "$identity_count"
