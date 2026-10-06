# Dokploy deployment

The `ensombl-auth` project hosts FreightCheck only. Plansombl stays on GitHub authentication;
other products are deferred. The Ensombl organization remains the operator organization.
PostgreSQL is a separate native Dokploy database, not a Compose service.

## Required configuration

Dokploy receives only `BWS_ACCESS_TOKEN` and `BWS_PROJECT_ID` for the recreated `ensombl-auth`
Bitwarden project. Its machine account needs read/write access for bootstrap to persist client
credentials; reduce it to read-only after successful bootstrap and restore write access when
adding or rotating clients.

Required Bitwarden secrets:

- `ZITADEL_DATABASE_URL`: internal DSN of the dedicated native PostgreSQL database.
- `ZITADEL_MASTERKEY`: exactly 32 random bytes, immutable for that database's lifetime.
- `ZITADEL_INITIAL_ADMIN_PASSWORD`: initial password for `patrick@ensombl.io`.
- `RESEND_API_KEY`: preserve the existing auth key unchanged. Do not create, rotate, or substitute it.

Initial setup and reconciliation both use `FreightCheck <noreply@notifications.ensombl.io>`
with reply-to `noreply@notifications.ensombl.io`. Before deployment, verify the existing key's
permitted sender domain. Resolve any discrepancy before sending; the screenshot of
“Freightcheck - Staging API” does not select or authorize a replacement key.

Generated credentials are listed in [the manifest](../deploy/secrets/manifest.json), including
staging and production invitation accounts. Keep their values out of logs and PRs.

## Fresh rebuild procedure

This is future operational work; the code changes do not perform any reset or deployment.

1. Inspect the existing `freightclaims-auth` deployment read-only and record the structure to
   replicate. This comparison is still pending; do not modify that reference deployment.
2. Inventory the exact `ensombl-auth` BWS and Dokploy project IDs, machine-account access,
   domains, database, backups, and named volumes. Record which database and volume state is
   removed or recreated. Project deletion alone does not guarantee a fresh instance.
3. Securely preserve the selected auth `RESEND_API_KEY` and confirm its sender-domain access.
4. Delete and recreate the BWS project named `ensombl-auth`. Supply the required bootstrap
   secrets and the same Resend key. Pair the master key with the intended new database state.
5. Delete and recreate the Dokploy project named `ensombl-auth` using the reference structure,
   dedicated fresh PostgreSQL state, and explicitly inventoried volume handling. Configure the
   reviewed revision and the routes below. Preserve the reference deployment and other products.
6. Deploy that revision and bootstrap FreightCheck only. Verify the Ensombl operator
   organization, FreightCheck organization, roles, applications, management/migration accounts,
   and organization-scoped invitation accounts. Check that no FreightClaims resources or
   generated credentials exist in the recreated projects.
7. Refresh FreightCheck OIDC and invitation credentials from bootstrap output and deploy the
   coordinated FreightCheck API, worker, scheduler, and web changes.
8. Verify actual SMTP delivery, native account setup, login, pending invitations, membership
   acceptance, and FreightCheck branding in light and dark mode.
9. Before production launch, change the organization-wide invitation return destination from
   `https://app.staging.freightcheck.io/auth/login?returnTo=%2Finvitations` to
   `https://app.freightcheck.io/auth/login?returnTo=%2Finvitations`. Standalone invitation setup
   cannot choose a separate destination per OIDC application.

## Routing

The canonical issuer is `https://auth.freightcheck.io`. Dokploy Traefik terminates TLS.
Configure the Compose application's Domains tab with HTTPS and Let's Encrypt; Dokploy injects
routing labels and its network. The Compose file deliberately declares neither.

| Host | Public path | Service | Port | Internal path | Strip path |
| --- | --- | --- | ---: | --- | --- |
| `auth.freightcheck.io` | `/` | `zitadel-api` | 8080 | `/` | No |
| `auth.freightcheck.io` | `/assets` | `zitadel-api` | 8080 | `/` | No |
| `auth.freightcheck.io` | `/ui/v2/login` | `product-login-root` | 8080 | `/` | No |
| `auth.freightcheck.io` | `/admin/v1` | `zitadel-api` | 8080 | `/` | No |
| `auth.freightcheck.io` | `/admin` | `zitadel-api` | 8080 | `/ui/console` | Yes |

Keep more-specific paths ahead of `/`, and `/admin/v1` ahead of the `/admin` shortcut so admin
API requests retain their path. `/ui/console` remains the native console path; `/admin` is its
shortcut. Login V2 uses the proxy, while issuer discovery, API requests, and branding assets
reach `zitadel-api` directly. Do not add FreightClaims routes.

## Recovery

Back up the native PostgreSQL database with its matching master key and reviewed Git revision.
Document retention, monitor backup completion, and test restores into isolated database and
volume state before relying on them for recovery.
