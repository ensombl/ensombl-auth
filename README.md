# Ensombl Auth

Ensombl Auth is the shared, self-hosted ZITADEL identity platform for Ensombl products. It owns
authentication, credentials, account recovery, product login branding, OIDC applications, and
product-scoped service accounts.

Customer tenants, memberships, application roles, permissions, and row-level security remain in
each product database. ZITADEL organizations represent product identity ownership; they do not
represent application tenants.

## Requirements

- Node.js 24
- pnpm 11
- Docker with Compose

## Local development

Install dependencies and start the disposable local stack:

```bash
pnpm install
pnpm dev
```

The local issuer is `http://localhost:24455`; its Console is available at
`http://localhost:24455/ui/console`. Mailpit is available at `http://localhost:28025`.

Run the repository checks with:

```bash
pnpm check
```

Product repositories consume this repository as a pinned submodule so local development uses the
same ZITADEL and catalog bootstrap implementation as hosted environments.

## Repository layout

```text
deploy/
  bootstrap/   ZITADEL catalog bootstrap
  dokploy/     Hosted Compose definition
  products/    Non-secret product catalog and branding
  secrets/     Bitwarden secret manifest and loader
  zitadel/     ZITADEL and Login V2 configuration
docs/          Architecture, authorization, and deployment reference
tests/         Catalog, Compose, bootstrap, and policy tests
```

## Hosted service

`https://auth.ensombl.io` is the canonical issuer. Product login hosts provide product branding
while the issuer and APIs remain canonical. Dokploy builds the repository sources directly; this
project does not publish container images.

See:

- [Architecture](docs/architecture.md)
- [Roles and permissions](docs/roles-and-permissions.md)
- [Dokploy deployment](docs/dokploy.md)
- [Product catalog](deploy/products/README.md)
