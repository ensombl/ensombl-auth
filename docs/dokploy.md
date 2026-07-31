# Dokploy deployment

The auth stack is a Dokploy Compose application. PostgreSQL is a separate native Dokploy database,
not a Compose service.

## Required Dokploy environment

- `BWS_ACCESS_TOKEN`: token for the `ensombl-auth` Bitwarden machine account.
- `BWS_PROJECT_ID`: UUID of the `ensombl-auth` Bitwarden project.

The machine account needs write access only for the first successful catalog reconciliation, which
creates OIDC clients and persists their one-time client secrets. Change it to read-only after the
first deployment.

## Required Bitwarden secrets

- `ZITADEL_DATABASE_URL`: internal native-PostgreSQL DSN with TLS settings appropriate to Dokploy.
- `ZITADEL_MASTERKEY`: exactly 32 random bytes; immutable for the lifetime of the instance.
- `ZITADEL_INITIAL_ADMIN_PASSWORD`: initial password for `patrick@ensombl.io`.
- `RESEND_API_KEY`: sending-only Resend key for `noreply@notifications.ensombl.io`.

The reconciler creates the product runtime entries documented in
[`deploy/secrets/manifest.json`](../deploy/secrets/manifest.json). These are consumed by product
deployments; they are not injected into the ZITADEL runtime.

## Routing

Dokploy Traefik terminates TLS. ZITADEL and Login V2 receive h2c/HTTP only on the private network.

- `https://auth.ensombl.io/ui/console` is the ZITADEL Console.
- `https://auth.ensombl.io/admin` redirects to the Console.
- `auth.freightclaims.com` and `auth.freightcheck.io` serve Login V2 for their product applications.
  The OIDC issuer and API endpoints remain canonical at `auth.ensombl.io`.
- Each OIDC application receives its product's Login V2 base URI from `auth_origin`. The
  application context selects product branding; the hostname does not become a second issuer.

## Recovery

This repository has one current ZITADEL contract. It does not carry retired auth database
definitions or a second runtime mode. Recovery uses the native PostgreSQL backup and restore
procedure plus the reviewed Git revision.
