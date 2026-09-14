# Dokploy deployment

The auth stack is a Dokploy Compose application. PostgreSQL is a separate native Dokploy database,
not a Compose service.

## Required Dokploy environment

- `BWS_ACCESS_TOKEN`: token for the `ensombl-auth` Bitwarden machine account.
- `BWS_PROJECT_ID`: UUID of the `ensombl-auth` Bitwarden project.

The machine account needs write access only for the first successful catalog bootstrap, which
creates OIDC clients and persists their one-time client secrets. Change it to read-only after the
first deployment.

## Required Bitwarden secrets

- `ZITADEL_DATABASE_URL`: internal native-PostgreSQL DSN with TLS settings appropriate to Dokploy.
- `ZITADEL_MASTERKEY`: exactly 32 random bytes; immutable for the lifetime of the instance.
- `ZITADEL_INITIAL_ADMIN_PASSWORD`: initial password for `patrick@ensombl.io`.
- `RESEND_API_KEY`: sending-only Resend key for `noreply@notifications.ensombl.io`.

The bootstrap creates the product runtime entries documented in
[`deploy/secrets/manifest.json`](../deploy/secrets/manifest.json). These are consumed by product
deployments; they are not injected into the ZITADEL runtime.

## Routing

Dokploy Traefik terminates TLS. Public routing is owned by the Compose application's **Domains**
tab; `deploy/dokploy/compose.yml` intentionally contains no Traefik labels or manually declared
`dokploy-network`. Dokploy injects both when it deploys the registered domains.

Configure these HTTPS domains with a Let's Encrypt certificate:

| Host | Public path | Service | Port | Internal path | Strip path |
| --- | --- | --- | ---: | --- | --- |
| `auth.ensombl.io` | `/` | `zitadel-api` | 8080 | `/` | No |
| `auth.ensombl.io` | `/ui/v2/login` | `product-login-root` | 8080 | `/` | No |
| `auth.ensombl.io` | `/admin/v1` | `zitadel-api` | 8080 | `/` | No |
| `auth.ensombl.io` | `/admin` | `zitadel-api` | 8080 | `/ui/console` | Yes |
| `auth.freightclaims.com` | `/` | `product-login-root` | 8080 | `/` | No |
| `auth.freightclaims.com` | `/ui/v2/login` | `product-login-root` | 8080 | `/` | No |
| `auth.freightclaims.com` | `/assets` | `product-login-root` | 8080 | `/` | No |
| `auth.freightcheck.io` | `/` | `product-login-root` | 8080 | `/` | No |
| `auth.freightcheck.io` | `/ui/v2/login` | `product-login-root` | 8080 | `/` | No |
| `auth.freightcheck.io` | `/assets` | `product-login-root` | 8080 | `/` | No |

The more-specific Login V2, branding-asset, and `/admin` paths take precedence over each host's `/`
route. Login V2 resolves the active organization logo against its public hostname, so
`product-login-root` proxies Login V2 and `/assets` while preserving the public product hostname. It
limits repeated username submissions at the public ingress; this bounds native setup-email triggers
for identities that do not have an authentication method. It redirects the exact `/` path to Login
V2 and returns 404 for every other product-host path. The native `/admin/v1`
passthrough must remain more specific than the `/admin` Console shortcut; otherwise the shortcut's
path rewrite breaks ZITADEL's Admin API. A Compose redeploy is required after changing any of these
domain records.

- `https://auth.ensombl.io/ui/console` is the ZITADEL Console.
- `https://auth.ensombl.io/admin` is rewritten internally to the Console.
- `auth.freightclaims.com` and `auth.freightcheck.io` serve Login V2 for their product applications.
  The OIDC issuer and API endpoints remain canonical at `auth.ensombl.io`.
- Each OIDC application receives its product's Login V2 base URI from `auth_origin`. The
  application context selects product branding; the hostname does not become a second issuer.
- Login V2 is enabled per application, not forced instance-wide. This lets product applications use
  their own login hosts while the ZITADEL Console remains on `auth.ensombl.io`.
- Product login hosts are native trusted domains on the initial ZITADEL instance. Login V2 sends
  `auth.ensombl.io` as the instance host while preserving the product hostname as the public host.

## Recovery

Catalog bootstrap also applies English registration guidance through the Settings V2 translation
API, preserving unrelated instance text. Creation failures offer retry or a return to sign-in
without confirming whether an address exists. The existing Back button retains the login flow;
no account lookup or automatic redirect is added. Restart the login service after bootstrap to
refresh cached translations immediately, or allow its translation cache to expire.

Recovery uses a native PostgreSQL backup together with the matching reviewed Git revision. Configure
a documented retention policy, monitor backup completion, and perform periodic restore tests into
an isolated database before relying on the backup for disaster recovery.

## FreightCheck directory reader rollout

`deploy/zitadel/permissions.json` preserves all 26 built-in role mappings from
[ZITADEL v4.16.2](https://github.com/zitadel/zitadel/blob/v4.16.2/cmd/defaults.yaml) and adds
`IAM_FREIGHTCHECK_DIRECTORY_READER` with only `user.read`. Both Compose definitions load this file.
The pinned-default digest in `tests/directory-permissions.test.ts` detects changes to built-in roles.
Refresh the built-in mappings and digest from the reviewed upstream release when upgrading ZITADEL.
Do not override the mapping list with the custom role alone.

Deploy the auth configuration first. `start-from-init` runs setup, which synchronizes the role
mappings before catalog bootstrap replaces FreightCheck management accounts' instance viewer role
with the custom reader. Deploy the FreightCheck API and worker after bootstrap succeeds. Confirm
that the management credential can read an Ensombl identity but cannot update it or read instance
login policies. Directory visibility checks deliberately reject missing or organization-only reader
assignments. Existing organization-scoped user management permissions remain in place.

Before deploying the removal of experimental enrollment tracking, inspect outbox rows of type
`identity.enrolled` and pg-boss jobs named `identity-enrollment`. Stop old producers and workers,
retire only those jobs, and mark their outbox rows processed without changing memberships. Remove
only `enrolled` from FreightCheck project grants, preserve other role assignments, then remove the
project role. If no enrollment tracking was deployed, no queue or grant cleanup is needed.

Rollback requires restoring the previous application visibility check together with the previous
service-account role. Do not remove the custom mapping while an application still requires it.
