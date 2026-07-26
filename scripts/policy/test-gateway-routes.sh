#!/bin/sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/../.." && pwd)"
test_root="$(mktemp -d)"
active_gateway=""
active_backend=""
active_network=""

cleanup_runtime() {
  if [ -n "$active_gateway" ]; then
    docker rm --force "$active_gateway" >/dev/null 2>&1 || true
    active_gateway=""
  fi
  if [ -n "$active_backend" ]; then
    docker rm --force "$active_backend" >/dev/null 2>&1 || true
    active_backend=""
  fi
  if [ -n "$active_network" ]; then
    docker network rm "$active_network" >/dev/null 2>&1 || true
    active_network=""
  fi
}

cleanup() {
  cleanup_runtime
  rm -rf "$test_root"
}
trap 'status=$?; trap - EXIT; cleanup; exit "$status"' EXIT
trap 'exit 130' INT TERM

assert_adapted_order() {
  config_path="$1"
  output_path="$2"
  label="$3"

  docker run --rm \
    --volume "$config_path:/etc/caddy/Caddyfile:ro" \
    caddy:2.10-alpine \
    caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile \
    >"$output_path"

  jq -e --arg label "$label" '
    .apps.http.servers.srv0.routes[0].handle as $outer
    | ($outer | map(select(.handler == "headers"))[0].response.set) as $security
    | .apps.http.servers.srv0.routes[0].handle
    | map(select(.handler == "subroute"))[0].routes as $routes
    | ($routes | map(select(
        (.match[0].path // []) | index("/ui/*")
      )) | .[0].handle[0].response.set) as $flow_headers
    | ($routes | to_entries | map(select(
        (.value.match[0].path // []) | index("/internal/*")
      )) | .[0]) as $private
    | ($routes | to_entries | map(select(
        (.value.match // null) == null
        and .value.handle[0].routes[0].handle[0].handler == "reverse_proxy"
      )) | .[0]) as $catchall
    | ($security["Content-Security-Policy"] == ["frame-ancestors '\''none'\''"])
      and ($security["X-Frame-Options"] == ["DENY"])
      and ($security["X-Content-Type-Options"] == ["nosniff"])
      and ($security["Referrer-Policy"] == ["no-referrer"])
      and (
        if $label == "production"
        then $security["Strict-Transport-Security"] == ["max-age=31536000; includeSubDomains"]
        else ($security | has("Strict-Transport-Security") | not)
        end
      )
      and ($flow_headers["Cache-Control"] == ["no-store"])
      and ($private.key < $catchall.key)
      and ($private.value.handle[0].routes[0].handle[0].handler == "static_response")
      and ($private.value.handle[0].routes[0].handle[0].status_code == 404)
      and (($private.value.match[0].path | index("/internal")) != null)
      and (($private.value.match[0].path | index("/admin/*")) != null)
      and (($private.value.match[0].path | index("/admin")) != null)
      and (($private.value.match[0].path | index("/relation-tuples/*")) != null)
      and (($private.value.match[0].path | index("/permissions/*")) != null)
  ' "$output_path" >/dev/null
}

runtime_response() {
  gateway_name="$1"
  request_path="$2"
  docker exec "$gateway_name" \
    wget -S -O - "http://127.0.0.1:8080$request_path" 2>&1 || true
}

assert_header() {
  response="$1"
  expected="$2"
  if ! printf '%s\n' "$response" | grep -Fiq "$expected"; then
    printf 'Expected response header %s, received:\n%s\n' "$expected" "$response" >&2
    exit 1
  fi
}

assert_security_headers() {
  label="$1"
  response="$2"
  assert_header "$response" "Content-Security-Policy: frame-ancestors 'none'"
  assert_header "$response" "X-Frame-Options: DENY"
  assert_header "$response" "X-Content-Type-Options: nosniff"
  assert_header "$response" "Referrer-Policy: no-referrer"
  if [ "$label" = production ]; then
    assert_header "$response" "Strict-Transport-Security: max-age=31536000; includeSubDomains"
  elif printf '%s\n' "$response" | grep -Fiq "Strict-Transport-Security:"; then
    printf 'Local gateway unexpectedly emitted HSTS:\n%s\n' "$response" >&2
    exit 1
  fi
}

assert_private_response() {
  gateway_name="$1"
  request_path="$2"
  response="$(runtime_response "$gateway_name" "$request_path")"
  if ! printf '%s\n' "$response" | grep -Fq "HTTP/1.1 404 Not Found"; then
    printf 'Expected 404 for %s, received:\n%s\n' "$request_path" "$response" >&2
    exit 1
  fi
  if printf '%s\n' "$response" | grep -Fq "upstream-reached"; then
    printf 'Private path reached the catch-all upstream: %s\n' "$request_path" >&2
    exit 1
  fi
}

assert_runtime_boundary() {
  label="$1"
  config_path="$2"
  backend_port="$3"
  network_name="ensombl-auth-gateway-test-$$-$label"
  backend_name="$network_name-backend"
  gateway_name="$network_name-gateway"

  active_network="$network_name"
  active_backend="$backend_name"
  active_gateway="$gateway_name"

  docker network create "$network_name" >/dev/null
  docker run --detach --name "$backend_name" \
    --network "$network_name" \
    --network-alias control-plane \
    --network-alias kratos \
    --network-alias hydra \
    --entrypoint /bin/sh \
    caddy:2.10-alpine \
    -c "caddy respond --listen :$backend_port --header 'Cache-Control: public' --body upstream-reached & caddy respond --listen :4433 --header 'Cache-Control: public' --body upstream-reached & caddy respond --listen :4444 --header 'Cache-Control: public' --body upstream-reached & wait" >/dev/null

  if [ "$label" = "local" ]; then
    backend_ip="$(
      docker inspect \
        --format "{{(index .NetworkSettings.Networks \"$network_name\").IPAddress}}" \
        "$backend_name"
    )"
    docker run --detach --name "$gateway_name" \
      --network "$network_name" \
      --add-host "host.docker.internal:$backend_ip" \
      --volume "$config_path:/etc/caddy/Caddyfile:ro" \
      caddy:2.10-alpine >/dev/null
  else
    docker run --detach --name "$gateway_name" \
      --network "$network_name" \
      --volume "$config_path:/etc/caddy/Caddyfile:ro" \
      caddy:2.10-alpine >/dev/null
  fi

  attempts=0
  until docker exec "$gateway_name" \
    wget -q -O - http://127.0.0.1:8080/gateway-healthz >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 20 ]; then
      docker logs "$gateway_name" >&2
      exit 1
    fi
    sleep 1
  done

  attempts=0
  until [ "$(
    docker exec "$gateway_name" \
      wget -q -O - http://127.0.0.1:8080/ 2>/dev/null || true
  )" = "upstream-reached" ]; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 20 ]; then
      docker logs "$backend_name" >&2
      docker logs "$gateway_name" >&2
      exit 1
    fi
    sleep 1
  done

  public_body="$(
    docker exec "$gateway_name" wget -q -O - http://127.0.0.1:8080/
  )"
  if [ "$public_body" != "upstream-reached" ]; then
    printf 'Catch-all backend was not reachable for %s gateway\n' "$label" >&2
    exit 1
  fi

  ui_response="$(runtime_response "$gateway_name" "/ui/login")"
  assert_security_headers "$label" "$ui_response"
  assert_header "$ui_response" "Cache-Control: no-store"

  flow_response="$(runtime_response "$gateway_name" "/self-service/login/browser")"
  assert_security_headers "$label" "$flow_response"
  assert_header "$flow_response" "Cache-Control: no-store"

  discovery_response="$(runtime_response "$gateway_name" "/.well-known/openid-configuration")"
  assert_security_headers "$label" "$discovery_response"
  assert_header "$discovery_response" "Cache-Control: public"
  if printf '%s\n' "$discovery_response" | grep -Fiq "Cache-Control: no-store"; then
    printf 'Discovery caching was overwritten for %s gateway\n' "$label" >&2
    exit 1
  fi

  for request_path in \
    /internal \
    /internal/test \
    /admin \
    /admin/identities \
    /relation-tuples \
    /relation-tuples/check/openapi \
    /permissions \
    /permissions/check \
    /clients \
    /keys/test \
    /health/ready \
    /metrics \
    /debug/pprof; do
    assert_private_response "$gateway_name" "$request_path"
  done

  cleanup_runtime
}

production_config="$repo_root/deploy/gateway/Caddyfile"
local_config="$repo_root/deploy/gateway/Caddyfile.local"

assert_adapted_order "$production_config" "$test_root/production.json" production
assert_adapted_order "$local_config" "$test_root/local.json" local
assert_runtime_boundary production "$production_config" 3000
assert_runtime_boundary local "$local_config" 3400

echo "Gateway private-route boundary passed for production and local configurations."
