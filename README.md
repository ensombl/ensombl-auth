# Ensombl global identity

This repository is the source of truth for the global self-hosted Ory control
plane. `https://auth.ensombl.io` is the canonical OIDC issuer and default
Ensombl UI. `https://auth.freightclaims.ensombl.io` and
`https://auth.freightcheck.com` are the FreightClaims- and
FreightCheck-branded browser entrypoints.

It is intentionally separate from every product repository. A Kratos identity
can be admitted to more than one Ensombl product, while Hydra clients, exact
redirect URIs, product audiences, and Keto relations keep product access
isolated.

## What runs here

- Ory Kratos for shared identities, passwords, MFA, recovery, verification,
  settings, and host-scoped browser identity sessions.
- Ory Hydra for OAuth 2.0/OIDC and product-specific machine clients.
- Ory Keto for global and product authorization relationships.
- A source-built SvelteKit control application for Kratos self-service screens,
  Hydra login/consent/logout, invitations, product admission, and the migrated
  password reset gate.
- Four isolated PostgreSQL databases: one each for Kratos, Hydra, Keto, and
  the small auth-control store.
- Checked-in Dokploy Traefik routes for the exact public control, Kratos, and
  Hydra paths. Ory admin APIs and control endpoints have no public router.
- One singleton Kratos courier and an internal, product-aware Resend boundary.
  Auth email always uses `noreply@notifications.ensombl.io`; the display name
  comes from the reviewed product catalog and defaults to `Ensombl`.

The application uses Node 24, pnpm 11, TypeScript, SvelteKit, and Turborepo,
matching the relevant runtime and frontend patterns in Exhibit A. No project
container is published to a registry. Dokploy builds the control application
and thin, configuration-only Ory images directly from the reviewed Git
revision. Hosted PostgreSQL is provided by four native Dokploy database
services and is not part of the Compose stack. Caddy remains only in the
disposable local development stack.

## Local development

Prerequisites: Node 24, pnpm 11, and Docker with Compose.

This workflow is also the canonical disposable auth stack for product
development. Product repositories pin this repository and start it locally;
they do not maintain copies of the Ory configuration.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts four isolated PostgreSQL services, Mailpit, Kratos, Hydra,
Keto, and the same-origin gateway, applies each component's normal versioned
migration, then starts the SvelteKit control application and durable
invitation-activation reconciler with one clean Ctrl-C lifecycle.

The auth-control migration consumes only `AUTH_CONTROL_MIGRATION_URL`; local
development supplies a loopback-only default, while hosted deployments must
provide the explicit internal URL of the dedicated native auth-control
database.

Local endpoints:

- Auth gateway: `http://localhost:24455`
- Control application (direct): `http://localhost:3400`
- Mailpit: `http://localhost:28025`
- Kratos public/admin: `http://localhost:24433` / `http://localhost:24434`
- Hydra public/admin: `http://localhost:24444` / `http://localhost:24445`
- Keto read/write: `http://localhost:24466` / `http://localhost:24467`

Local credentials and secrets in `docker-compose.yml` are explicit disposable
fixtures. They are rejected as a hosted deployment pattern.

For the Angular/FreightClaims human-login path, run the idempotent local-only
seed after the stack is ready:

```bash
pnpm identity:seed:dev
```

The fixture is `developer@freightclaims.test` with initial password
`FreightClaims-Dev-2026!` and `Product:freightclaims:local#access`. It is created
inactive, admitted, and then activated without a migration reset gate. Reruns
reuse the identity and relation and never reset a password the developer has
changed. The command hard-fails for production or non-loopback dependencies;
it also assigns `tenant_admin` in the deterministic local FreightClaims tenant.
This fixture is separate from the audited staging and production importers.

## Tenant roles

Every product gets the default tenant role stack unless it declares otherwise:

- `member` grants `access`
- `admin` grants `access` and `administer`
- `owner` grants `access`, `administer`, and `owner`

`tenant_roles.mode: "extend"` adds roles or permissions while retaining those
defaults. `tenant_roles.mode: "replace"` defines the complete product role
model. FreightClaims replaces the defaults with `member`, `adjuster`, and
`tenant_admin`; its product service sends those exact role identifiers through
the private membership API. Tenant IDs are opaque product-owned strings.

## Security invariants

- Public self-registration is disabled. Invitations create or locate an
  identity through the private control endpoint and dispatch a Kratos recovery
  code. Product admission is granted only by the audited, idempotent
  post-recovery hook while the invitation is valid.
- Every Hydra login and consent request rechecks both the reset gate and Keto
  product admission, including requests where Hydra reports `skip=true`.
- A migrated password can establish a Kratos session only to enter settings.
  Kratos v26.2.0 rejects reusing the current password. Its synchronous settings
  hook revokes every identity session before clearing the reset gate
  idempotently; the user then authenticates again with the replacement
  password.
- Ory cookies are host-only for each configured auth hostname. No
  `.ensombl.io` parent cookie is used, so the identity is global while browser
  sessions remain isolated by auth hostname.
- The five product-facing HTTPS routes require independent, client-scoped
  bearer secrets. Dokploy Traefik exposes no other `/internal/*` route.
- Passwords, ciphertext, password hashes, OAuth tokens, recovery codes, and
  secrets are never written to application logs or the auth-control database.
- Hosted identity batches enter only through the exact bearer-protected
  identity-migration API. A user is created inactive, durably reset-gated, and
  product-admitted before activation; split failures resume from the
  hash-bound ledger.
- Reviewed staging and production batches can map the same legacy source user to
  one global identity. A later source never replaces an active password or
  reasserts a reset gate already completed in the earlier environment.
- Every migrated identity is admitted only to its reviewed product and exact
  product/organization tenant bindings; product admission alone never grants
  FreightClaims tenant access.
- Hydra public and admin listeners run in separate processes and networks.
  Kratos v26 exposes both listeners from one process, but Traefik routes only
  its public paths; the resulting shared-network trust boundary is documented
  in `docs/architecture.md`.

## Deployment

The Dokploy Compose definition is
[`deploy/dokploy/compose.yml`](deploy/dokploy/compose.yml). Follow
[`docs/dokploy.md`](docs/dokploy.md) before creating the application.

With the disposable local stack and control application running,
`pnpm test:e2e:reset` verifies a fixed Argon2id PHC produced by the FreightClaims
TypeScript migrator through old-password login, forced reset, same-password
rejection, session revocation, fresh login, authorization code, and token
exchange.

The hosted deployment deliberately fails closed until its secrets have been
injected. The checked-in
[`deploy/secrets/manifest.json`](deploy/secrets/manifest.json) is the complete
non-secret inventory. Shared `.env` files are forbidden.

## Product configuration

[`deploy/products/products.json`](deploy/products/products.json) is the
non-secret global product catalog applied on every deployment. It drives the
control-plane client/product map, trusted clients, allowed return origins, and
idempotent Hydra client reconciliation.

The hosted product clients are:

| Product | Environment | Client | Base origin | Audience |
| --- | --- | --- | --- | --- |
| FreightClaims | staging | `freightclaims-staging-web` | `https://app.staging.freightclaims.ensombl.io` | `freightclaims-staging` |
| FreightClaims | production/migration | `freightclaims-production-web` | `https://app.freightclaims.ensombl.io` | `freightclaims-production` |
| FreightCheck | staging | `freightcheck-staging-web` | `https://app.staging.freightcheck.io` | `freightcheck-staging` |
| FreightCheck | production | `freightcheck-production-web` | `https://app.freightcheck.io` | `freightcheck-production` |

All use Authorization Code, refresh tokens, and
`openid offline_access email profile`. Their Bitwarden-managed secrets are
independent. FreightClaims uses `https://auth.freightclaims.ensombl.io`;
FreightCheck uses `https://auth.freightcheck.com`. The token issuer remains
`https://auth.ensombl.io`. FreightCheck inherits the default
`member`/`admin`/`owner` tenant roles.
