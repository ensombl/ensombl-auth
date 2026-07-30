#!/bin/sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/../.." && pwd)"
test_root="$(mktemp -d)"
active_gateway=""
active_backend=""
active_network=""

cleanup() {
  if [ -n "$active_gateway" ]; then
    docker rm --force "$active_gateway" >/dev/null 2>&1 || true
  fi
  if [ -n "$active_backend" ]; then
    docker rm --force "$active_backend" >/dev/null 2>&1 || true
  fi
  if [ -n "$active_network" ]; then
    docker network rm "$active_network" >/dev/null 2>&1 || true
  fi
  rm -rf "$test_root"
}
trap 'status=$?; trap - EXIT; cleanup; exit "$status"' EXIT
trap 'exit 130' INT TERM

production_json="$test_root/production.json"
"$repo_root/scripts/policy/validate-dokploy-compose.sh" --format json >"$production_json"

jq -e '
  .services as $services
  | ($services | has("gateway") | not)
    and ($services.kratos.networks | has("dokploy-network"))
    and ($services["kratos-freightclaims"].networks | has("dokploy-network"))
    and ($services["hydra-public"].networks | has("dokploy-network"))
    and ($services["control-plane"].networks | has("dokploy-network"))
    and ($services["hydra-admin"].networks | has("dokploy-network") | not)
    and (
      $services.kratos.labels["traefik.http.routers.ensombl-auth-kratos.rule"]
      | contains("PathPrefix(`/self-service/`)")
    )
    and (
      $services["kratos-freightclaims"].labels["traefik.http.routers.ensombl-auth-kratos-freightclaims.rule"]
      | contains("Host(`auth.freightclaims.ensombl.io`)")
    )
    and (
      $services["kratos-freightclaims"].labels["traefik.http.middlewares.ensombl-auth-product-freightclaims.headers.customrequestheaders.X-Ensombl-Auth-Product"]
      == "freightclaims"
    )
    and ($services.kratos.command | index("--watch-courier") | not)
    and ($services["kratos-freightclaims"].command | index("--watch-courier") | not)
    and ($services["kratos-courier"].command == ["courier", "watch", "--config", "/etc/config/kratos/kratos.yml"])
    and ($services["kratos-courier"].networks | has("dokploy-network") | not)
    and (
      $services["hydra-public"].labels["traefik.http.routers.ensombl-auth-hydra.rule"]
      | contains("PathPrefix(`/oauth2/`)")
    )
    and (
      $services["hydra-public"].labels["traefik.http.routers.ensombl-auth-discovery.rule"]
      | contains("PathPrefix(`/.well-known/`)")
    )
    and (
      $services["control-plane"].labels["traefik.http.routers.ensombl-auth-control.rule"]
      | contains("PathPrefix(`/ui/`)")
    )
    and (
      $services["control-plane"].labels["traefik.http.routers.ensombl-auth-control.rule"]
      | contains("PathPrefix(`/_app/`)")
    )
    and (
      $services["control-plane"].labels["traefik.http.routers.ensombl-auth-control.rule"]
      | contains("Host(`auth.freightclaims.ensombl.io`)")
    )
    and (
      $services["control-plane"].depends_on["product-reconcile"].condition
      == "service_completed_successfully"
    )
    and (
      $services["control-plane"].labels["traefik.http.routers.ensombl-auth-control.rule"]
      | contains("/internal")
      | not
    )
    and (
      $services["control-plane"].labels["traefik.http.routers.ensombl-auth-product-api.rule"]
      == "Host(`auth.ensombl.io`) && (Path(`/internal/authorization/check`) || Path(`/internal/invitations`) || Path(`/internal/tenants/memberships`) || Path(`/internal/migration/identities`) || Path(`/internal/oauth2/introspect`))"
    )
    and (
      $services["control-plane"].labels["traefik.http.routers.ensombl-auth-product-api.rule"]
      | contains("/internal/courier")
      | not
    )
    and (
      $services["control-plane"].labels
      | has("traefik.http.middlewares.ensombl-auth-security.headers.framedeny")
    )
    and (
      $services["control-plane"].labels
      | has("traefik.http.middlewares.ensombl-auth-no-store.headers.customresponseheaders.Cache-Control")
    )
' "$production_json" >/dev/null

local_config="$repo_root/deploy/gateway/Caddyfile.local"
docker run --rm \
  --volume "$local_config:/etc/caddy/Caddyfile:ro" \
  caddy:2.10-alpine \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile \
  >"$test_root/local.json"

jq -e '
  .apps.http.servers.srv0.routes[0].handle
  | map(select(.handler == "subroute"))[0].routes as $routes
  | ($routes | to_entries | map(select(
      (.value.match[0].path // []) | index("/internal/*")
    )) | .[0]) as $private
  | ($routes | to_entries | map(select(
      (.value.match // null) == null
      and .value.handle[0].routes[0].handle[0].handler == "reverse_proxy"
    )) | .[0]) as $catchall
  | ($private.key < $catchall.key)
    and ($private.value.handle[0].routes[0].handle[0].status_code == 404)
' "$test_root/local.json" >/dev/null

active_network="ensombl-auth-local-gateway-test-$$"
active_backend="$active_network-backend"
active_gateway="$active_network-gateway"
docker network create "$active_network" >/dev/null
docker run --detach --name "$active_backend" \
  --network "$active_network" \
  --entrypoint /bin/sh \
  caddy:2.10-alpine \
  -c "caddy respond --listen :3400 --header 'Cache-Control: public' --body upstream-reached" \
  >/dev/null
backend_ip="$(
  docker inspect \
    --format "{{(index .NetworkSettings.Networks \"$active_network\").IPAddress}}" \
    "$active_backend"
)"
docker run --detach --name "$active_gateway" \
  --network "$active_network" \
  --add-host "host.docker.internal:$backend_ip" \
  --volume "$local_config:/etc/caddy/Caddyfile:ro" \
  caddy:2.10-alpine >/dev/null

attempts=0
until docker exec "$active_gateway" \
  wget -q -O - http://127.0.0.1:8080/gateway-healthz >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 20 ]; then
    docker logs "$active_gateway" >&2
    exit 1
  fi
  sleep 1
done

public_body="$(
  docker exec "$active_gateway" wget -q -O - http://127.0.0.1:8080/
)"
if [ "$public_body" != "upstream-reached" ]; then
  printf '%s\n' "Local Caddy did not reach the control application" >&2
  exit 1
fi

private_response="$(
  docker exec "$active_gateway" \
    wget -S -O - http://127.0.0.1:8080/internal/test 2>&1 || true
)"
if ! printf '%s\n' "$private_response" | grep -Fq "HTTP/1.1 404 Not Found"; then
  printf 'Expected local /internal route to return 404, received:\n%s\n' \
    "$private_response" >&2
  exit 1
fi

echo "Dokploy Traefik and local Caddy public-route boundaries passed."
