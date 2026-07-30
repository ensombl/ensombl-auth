# Ensombl identity

The global Ensombl identity platform is a self-hosted ZITADEL instance.

- `https://auth.ensombl.io` is the canonical OIDC issuer.
- ZITADEL organizations model Ensombl, product owners, and customer tenants.
- ZITADEL projects model products; applications model local, staging, and production clients.
- Project grants and user authorizations provide per-tenant roles for one global user identity.
- The built-in ZITADEL Console at `/ui/console` is the administrative UI.
- [`deploy/products/products.json`](deploy/products/products.json) is the non-secret product catalog.

Local product repositories use this repository as a pinned submodule and start the same ZITADEL
stack with `pnpm dev`. Dokploy builds the small operator images from source and pulls the pinned
official ZITADEL images; this repository never publishes container images.

Architecture and deployment details live in [`docs/architecture.md`](docs/architecture.md) and
[`docs/dokploy.md`](docs/dokploy.md).
