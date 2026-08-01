# Ensombl identity

The global Ensombl identity platform is a self-hosted ZITADEL instance.

- `https://auth.ensombl.io` is the canonical OIDC issuer.
- ZITADEL organizations model product identity ownership and, for B2B products, customer tenants.
- ZITADEL projects model products; applications model local, staging, and production clients.
- Project roles carry product-defined access in an organization context; multi-tenant products
  mirror those assignments into their database for RLS.
- The built-in ZITADEL Console at `/ui/console` is the administrative UI.
- [`deploy/products/products.json`](deploy/products/products.json) is the non-secret product catalog.

Local product repositories use this repository as a pinned submodule and start the same ZITADEL
stack with `pnpm dev`. Dokploy builds the small operator images from source and pulls the pinned
official ZITADEL images; this repository never publishes container images.

Architecture, authorization, and deployment details live in
[`docs/architecture.md`](docs/architecture.md),
[`docs/roles-and-permissions.md`](docs/roles-and-permissions.md), and
[`docs/dokploy.md`](docs/dokploy.md).
