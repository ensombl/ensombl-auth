# Global product catalog

`products.json` is the reviewed, non-secret declaration of products that use
the global `auth.ensombl.io` identity plane. It is applied on every deployment:

- the default and product auth brands define the allowed browser origins,
  visible UI names, and email From names;
- the auth sender address is global and non-secret:
  `noreply@notifications.ensombl.io`;
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
2. the matching Kratos host override and Traefik route, when the auth origin is
   new;
3. `deploy/ory/kratos/kratos.yml` return origins;
4. `deploy/secrets/manifest.json` for any new client secret;
5. product-side issuer, client, audience, callback, and logout configuration.

`products.local.json` exists only for this repository's isolated maintainer
tests. FreightClaims development owns its separate disposable Ory stack and
does not consume this file or this repository.

## Product service boundary

Product deployments run on separate infrastructure. They call only these exact
HTTPS routes at `auth.ensombl.io`:

- `POST /internal/authorization/check`
- `POST /internal/invitations`
- `PUT /internal/tenants/memberships`
- `PUT /internal/migration/identities`
- `POST /internal/oauth2/introspect`

Each route requires its catalog-declared, client-specific bearer secret. The
identity-management and migration endpoints derive the product from that
authenticated client, so one product cannot mutate another product's graph or
identity source. Traefik exposes no other `/internal/*` route: Ory hooks,
invitation reconciliation, the courier, and reset-gate controls stay on the
private Compose networks.
