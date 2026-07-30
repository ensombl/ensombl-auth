# Dokploy deployment runbook

## Hosted topology

The global auth deployment uses one Dokploy project and one `production`
environment on its own Dokploy installation.

Create these four native Dokploy PostgreSQL services:

| Dokploy service | Database | User |
| --- | --- | --- |
| `auth-kratos-db` | `kratos` | `kratos` |
| `auth-hydra-db` | `hydra` | `hydra` |
| `auth-keto-db` | `keto` | `keto` |
| `auth-control-db` | `auth_control` | `auth_control` |

The repository Compose stack contains no database. It contains only the Ory
processes, migrations, control plane, singleton courier, and invitation
reconciler. Each component runs its own versioned schema migration against its
dedicated native database.

Use Dokploy's standard Docker Compose deployment mode, not Docker Stack. Point
it at `deploy/dokploy/compose.yml`. Dokploy builds every checked-in Dockerfile
locally from the selected Git revision. No image is pushed to GHCR or any other
registry.

## External prerequisites

1. Connect the auth Dokploy installation to the private GitHub repository
   `ensombl/ensombl-auth`.
2. Configure the Compose deployment to watch protected branch `main`.
   There is no staging auth deployment or auth release branch.
3. Create the four native PostgreSQL services above. Do not expose an external
   database port.
4. Configure native database backups to independent object storage and prove
   an isolated restore before importing users.
5. Create DNS records for `auth.ensombl.io`,
   `auth.freightclaims.ensombl.io`, and `auth.freightcheck.io` pointing to the
   auth Dokploy installation.
6. Verify `notifications.ensombl.io` in Resend and create a sending-only API
   key restricted to that domain.
7. Create the Bitwarden Secrets Manager project `ensombl-auth`.
8. Create the Bitwarden machine account `ensombl-auth-runtime` and grant it
   `Can read` access to only the `ensombl-auth` project.
9. Generate one access token named
   `dokploy-auth-primary-<issued-yyyymmdd>` from that machine account.

## Required Bitwarden values

The Dokploy Compose environment contains exactly two bootstrap values:

| Variable | Secret | Constraint / consumer |
| --- | --- | --- |
| `BWS_ACCESS_TOKEN` | yes | `dokploy-auth-primary-<issued-yyyymmdd>` token |
| `BWS_PROJECT_ID` | no | UUID of the `ensombl-auth` project |

Copy the four internal connection URLs from the corresponding native Dokploy
database services. They must remain internal and must not use public database
ports.

| Secret | Constraint / consumer |
| --- | --- |
| `KRATOS_DATABASE_URL` | internal URL for `auth-kratos-db` |
| `HYDRA_DATABASE_URL` | internal URL for `auth-hydra-db` |
| `KETO_DATABASE_URL` | internal URL for `auth-keto-db` |
| `AUTH_CONTROL_DATABASE_URL` | internal URL for `auth-control-db` |
| `KRATOS_COOKIE_SECRET` | at least 32 random bytes |
| `KRATOS_CIPHER_SECRET` | exactly 32 characters |
| `HYDRA_SYSTEM_SECRET` | at least 32 random bytes |
| `HYDRA_PAIRWISE_SALT` | at least 32 random bytes; never rotate casually |
| `ORY_HOOK_SECRET` | private Kratos hook bearer |
| `MIGRATION_API_SECRET` | private migration control bearer |
| `INVITATION_RECONCILER_SECRET` | invitation activation retry worker |
| `AUTH_COURIER_SECRET` | singleton Kratos courier bearer |
| `RESEND_API_KEY` | auth sending-only Resend key |
| `FREIGHTCLAIMS_STAGING_AUTHORIZATION_DECISION_SECRET` | staging decision and introspection client |
| `FREIGHTCLAIMS_PRODUCTION_AUTHORIZATION_DECISION_SECRET` | production decision and introspection client |
| `FREIGHTCLAIMS_STAGING_IDENTITY_MANAGEMENT_SECRET` | staging invitations and memberships |
| `FREIGHTCLAIMS_PRODUCTION_IDENTITY_MANAGEMENT_SECRET` | production invitations and memberships |
| `FREIGHTCLAIMS_STAGING_IDENTITY_MIGRATION_SECRET` | staging identity synchronization |
| `FREIGHTCLAIMS_PRODUCTION_IDENTITY_MIGRATION_SECRET` | production identity synchronization |
| `FREIGHTCLAIMS_STAGING_HYDRA_CLIENT_SECRET` | staging BFF OAuth client |
| `FREIGHTCLAIMS_PRODUCTION_HYDRA_CLIENT_SECRET` | production BFF OAuth client |
| `FREIGHTCHECK_STAGING_AUTHORIZATION_DECISION_SECRET` | staging decision and introspection client |
| `FREIGHTCHECK_PRODUCTION_AUTHORIZATION_DECISION_SECRET` | production decision and introspection client |
| `FREIGHTCHECK_STAGING_IDENTITY_MANAGEMENT_SECRET` | staging invitations and memberships |
| `FREIGHTCHECK_PRODUCTION_IDENTITY_MANAGEMENT_SECRET` | production invitations and memberships |
| `FREIGHTCHECK_STAGING_HYDRA_CLIENT_SECRET` | staging BFF OAuth client |
| `FREIGHTCHECK_PRODUCTION_HYDRA_CLIENT_SECRET` | production BFF OAuth client |

The machine-readable allowlist is `deploy/secrets/manifest.json`. Generate all
non-provider secrets independently. Product client capability secrets must be
pairwise distinct.

Bitwarden is the live source of truth. Every hosted image contains the pinned,
checksum-verified BWS CLI. At process startup the common wrapper reads the
`ensombl-auth` project, maps only that process's declared secrets into its
environment, removes `BWS_ACCESS_TOKEN`, and then replaces itself with the real
process. Runtime secrets are not copied into the Dokploy environment.

All containers in this Compose deployment use the same token because Kratos,
Hydra, Keto, and auth control are one reviewed trust boundary. Do not reuse the
token in another deployment or grant `ensombl-auth-runtime` access to another
project. A separate Dokploy administration credential belongs in
`ensombl-dokploy-infrastructure` and is never available to this runtime.

Compose places the bootstrap token in Docker's container configuration.
Trusted Dokploy and Docker administrators can therefore inspect it even after
the wrapper removes it from the long-running process environment. Treat
administrative access to this Dokploy installation as access to the complete
`ensombl-auth` secrets project.

Bitwarden must be reachable when a container starts. An already-running process
continues with its loaded environment during a Bitwarden outage, but a restart
fails closed until retrieval succeeds.

The sender address is always `noreply@notifications.ensombl.io`. The reviewed
product catalog selects `Ensombl` as the default display name,
`FreightClaims` for FreightClaims-originated auth flows, and `FreightCheck` for
FreightCheck-originated auth flows. The auth Resend key has no inbound-email
or product application-mail access.

## Create the Compose deployment

1. Create one Compose service named `ensombl-auth`.
2. Select repository `ensombl/ensombl-auth`, branch `main`, and Compose path
   `deploy/dokploy/compose.yml`.
3. Select standard Docker Compose mode. Do not select Docker Stack and do not
   configure a container registry.
4. Set only `BWS_ACCESS_TOKEN` and `BWS_PROJECT_ID` in the Compose environment.
5. Enable automatic deployment for pushes to `main`.
6. Do not add Dokploy UI domains or host port mappings. The checked-in Traefik
   labels expose only the three approved auth hostnames and exact public paths.
7. Deploy only after all four native databases report healthy and every
   required value exists in the `ensombl-auth` project.

The deployment order inside the stack is:

1. Kratos, Hydra, Keto, and auth-control migrations.
2. Ory public/admin processes.
3. Hydra product-client reconciliation.
4. Control plane.
5. Singleton Kratos courier and invitation reconciliation worker.

PostgreSQL, Ory admin APIs, Keto, courier ingestion, hooks, reset gates, and
reconciliation have no public router. Only the reviewed product APIs are
reachable over HTTPS, and every request requires its environment-specific
bearer secret.

## Deployment source and secret rotation

`main` is the auth production source of truth. GitHub performs source checks
only; it does not receive Dokploy, Bitwarden, Resend, database, or Ory
credentials and never builds or publishes a container image.

For a secret rotation:

1. Generate and store the replacement in Bitwarden.
2. Redeploy the Compose stack so every process reloads from Bitwarden.
3. Verify every affected service.
4. Revoke the old provider credential only after the replacement is observed
   working.

For a `BWS_ACCESS_TOKEN` rotation, create a newly dated token on
`ensombl-auth-runtime`, replace the one Dokploy environment value, redeploy and
verify, then revoke the previous token.

Database credentials are rotated through the corresponding native Dokploy
database service and then copied into the matching internal URL. Treat Hydra
pairwise salt, Hydra system secrets, and Kratos cipher/cookie secrets as
stateful protocol keys requiring their own reviewed rotation plan.

## Pre-import gates

Verify:

```text
GET https://auth.ensombl.io/healthz                         -> 200
GET https://auth.ensombl.io/.well-known/openid-configuration -> 200
GET https://auth.freightclaims.ensombl.io/healthz           -> 200
GET https://auth.freightcheck.io/healthz                     -> 200
GET https://auth.ensombl.io/admin/anything                  -> 404
GET https://auth.ensombl.io/internal/anything               -> 404
GET https://auth.freightclaims.ensombl.io/internal/anything -> 404
GET https://auth.freightcheck.io/internal/anything           -> 404
```

- OIDC issuer and protocol endpoints use only `https://auth.ensombl.io`.
- FreightClaims browser login/recovery uses
  `https://auth.freightclaims.ensombl.io`.
- FreightCheck browser login/recovery uses `https://auth.freightcheck.io`.
- Staging and production OAuth clients contain only their exact callback and
  audience.
- Controlled recovery tests receive:
  - `Ensombl <noreply@notifications.ensombl.io>`
  - `FreightClaims <noreply@notifications.ensombl.io>`
  - `FreightCheck <noreply@notifications.ensombl.io>`
- A reset-gated identity cannot obtain a FreightClaims authorization code
  until it chooses a different password.
- A valid global identity without FreightClaims admission remains denied.
- Each of the four native databases has a successful encrypted backup and an
  isolated restore test.

Identity migration is performed through the exact protected
`POST /internal/migration/identities` API. The hosted auth stack does not
contain a source database reader, legacy credential decryptor, or direct
database import job. FreightClaims owns source selection and submits only its
validated canonical identity batch with the staging or production migration
capability.

Do not import staging or production users before every gate above passes.
