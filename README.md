# Ensombl global identity

This repository is the source of truth for the global self-hosted Ory control
plane at `https://auth.ensombl.io`.

It is intentionally separate from every product repository. A Kratos identity
can be admitted to more than one Ensombl product, while Hydra clients, exact
redirect URIs, product audiences, and Keto relations keep product access
isolated.

## What runs here

- Ory Kratos for identities, passwords, MFA, recovery, verification, settings,
  and browser identity sessions.
- Ory Hydra for OAuth 2.0/OIDC and product-specific machine clients.
- Ory Keto for global and product authorization relationships.
- A source-built SvelteKit control application for Kratos self-service screens,
  Hydra login/consent/logout, invitations, product admission, and the migrated
  password reset gate.
- PostgreSQL for the three Ory stores and the small auth-control database.
- Checked-in Dokploy Traefik routes for the exact public control, Kratos, and
  Hydra paths. Ory admin APIs and control endpoints have no public router.

The application uses Node 24, pnpm 11, TypeScript, SvelteKit, and Turborepo,
matching the relevant runtime and frontend patterns in Exhibit A. No project
container is published to a registry. Dokploy builds the control application
directly from the reviewed Git revision; the Compose stack only pulls pinned
upstream Ory and PostgreSQL images. Caddy remains only in the disposable local
development stack.

## Local development

Prerequisites: Node 24, pnpm 11, and Docker with Compose.

This workflow is for maintainers of the global auth platform. FreightClaims
development owns its own disposable Ory stack and does not clone, compose, or
seed this repository.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts PostgreSQL, Mailpit, Kratos, Hydra, Keto, and the same-origin
gateway, reconciles database roles, applies the auth-control migration and
least-privilege grants under an advisory lock, then starts the SvelteKit
control application and durable invitation-activation reconciler with one
clean Ctrl-C lifecycle.

The application `DATABASE_URL` is runtime-only. Migrations consume only the
dedicated `AUTH_CONTROL_MIGRATION_URL`; local development supplies a constrained
migrator default and rejects remote migration hosts, while hosted deployments
must provide an explicit non-loopback value.

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
`FreightClaims-Dev-2026!` and `Product:freightclaims#access`. It is created
inactive, admitted, and then activated without a migration reset gate. Reruns
reuse the identity and relation and never reset a password the developer has
changed. The command hard-fails for production or non-loopback dependencies;
this fixture is separate from the audited Stage and Production importers.

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
- Ory cookies are host-only for `auth.ensombl.io`. No `.ensombl.io` parent
  cookie is used.
- Internal APIs require independent bearer secrets and Dokploy Traefik has no
  router for `/internal/*`.
- Passwords, ciphertext, password hashes, OAuth tokens, recovery codes, and
  secrets are never written to application logs or the auth-control database.
- Identity batches enter only through a source-built stdin/tmpfs one-shot. A
  user is created inactive, durably reset-gated, and product-admitted before
  activation; split failures resume from a hash-bound ledger.
- Reviewed Stage and Production batches can map the same legacy source user to
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

FreightClaims currently declares two confidential clients:

| Environment | Client | Base origin | Audience |
| --- | --- | --- | --- |
| stage | `freightclaims-staging-web` | `https://app.staging.freightclaims.ensombl.io` | `freightclaims-staging` |
| production/migration | `freightclaims-production-web` | `https://app.freightclaims.ensombl.io` | `freightclaims-production` |

Both use Authorization Code, refresh tokens, and
`openid offline_access email profile`. Their Bitwarden-managed secrets are
independent. When FreightClaims moves to its final customer domain, update the
catalog and Kratos return-origin allowlist in one reviewed deployment.
