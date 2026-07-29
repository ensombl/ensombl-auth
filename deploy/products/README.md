# Global product catalog

`products.json` is the reviewed, non-secret declaration of products that use
the global `auth.ensombl.io` identity plane. It is applied on every deployment:

- the control plane derives the authoritative client-to-product map, trusted
  clients, and allowed return origins from it;
- the one-shot `product-reconcile` service creates or updates every declared
  Hydra client;
- Kratos' checked-in return-origin allowlist must contain the same origins.

Each hosted environment gets a distinct Hydra client ID, client secret,
authorization-decision secret, identity-management secret, and audience even
when staging and production share the same global Ory deployment.
An API must validate its exact environment audience; a staging token must never
be accepted by production.

The catalog contains environment-variable names that reference Bitwarden
values, never secret values. Adding or changing a product requires one reviewed
change that updates:

1. `products.json`;
2. `deploy/ory/kratos/kratos.yml` return origins;
3. `deploy/secrets/manifest.json` for any new client secret;
4. product-side issuer, client, audience, callback, and logout configuration.

`products.local.json` exists only for this repository's isolated maintainer
tests. FreightClaims development owns its separate disposable Ory stack and
does not consume this file or this repository.

## Private product decisions

Before deploying this stack and any product API on the same Docker host, create
the shared external network once:

```bash
docker network create ensombl-auth-product-decisions
```

The auth control container joins it with alias `ensombl-auth-control`.
FreightClaims staging and production API containers may join this network and
call only
`http://ensombl-auth-control:3000/internal/authorization/check` for decisions,
`/internal/invitations` for invitations, and
`/internal/tenants/memberships` for membership desired state. The matching
client-specific decision and identity-management secrets are injected into
both deployments from Bitwarden. The identity-management endpoint derives the
product from the authenticated client, so a product cannot mutate another
product's tenant graph. Do not attach Keto, Kratos admin, Hydra admin,
databases, workers, or migration jobs to this network. The network is private
application plumbing; it is not a substitute for the per-client bearer or
Traefik path restrictions.
