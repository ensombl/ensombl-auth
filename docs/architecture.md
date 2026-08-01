# Architecture

## Identity and tenancy model

One ZITADEL instance is the global Ensombl identity service. Each product organization owns the
identities admitted to that product. Multi-tenant products use customer organizations and external
role assignments without duplicating those identities.

| Ensombl concept | ZITADEL object |
| --- | --- |
| Global identity platform | Instance |
| Product identity owner and product branding | Product owner organization |
| FreightClaims or FreightCheck | Project |
| Local, staging, or production BFF | OIDC application |
| Human admitted to a product | User in the product organization |
| Customer tenant | Organization receiving a project grant |
| Per-tenant application role | External project role assignment |
| Tenant membership and RLS projection | Product database |
| Admin UI | ZITADEL Console |

Product projects are owned by dedicated product organizations. Enforcing project-owner branding
therefore makes the login screen deterministic from the OIDC client before the user is known. The
OIDC request includes the product organization scope, so only identities owned by that product
organization can log in. Customer organizations are authorization contexts; customer-tenant
branding belongs to the product UI.

Organization domains are identity-discovery and username-suffix domains, not service hostnames.
The catalog makes `ensombl.io` primary for the Ensombl organization and the declared
`freightclaims.com` and `freightcheck.io` domains primary for their respective product owners.
Bootstrap removes the automatic `<organization>.auth.ensombl.io` domains generated from ZITADEL's
external hostname.

The default product roles are `member`, `admin`, and `owner`. A product may extend or completely
replace that stack in the catalog. FreightClaims replaces it with `member`, `adjuster`,
`tenant_admin`, `platform_support`, `platform_admin`, `partner_api`, and `tai_api`. The bootstrap
removes roles outside the resolved catalog so obsolete role definitions cannot survive.

## Authentication

Products use Authorization Code with PKCE through a confidential BFF client. The canonical issuer
is `https://auth.ensombl.io`. Access and ID tokens contain ZITADEL project roles keyed by their
organization context. Each product requires the matching database membership and RLS context;
authentication alone never grants tenant data access.

Machine clients use ZITADEL API applications and standard token introspection. Product management
uses the environment's declared ZITADEL service account and short-lived client-credentials access
tokens. The initial IAM-owner PAT exists only inside the auth stack to apply the declarative
catalog and is mounted from the private bootstrap volume. Product workloads never receive it.

ZITADEL Console access uses built-in administrator permissions, not product project roles. The
seeded `patrick@ensombl.io` user is the initial instance administrator. Product management service
accounts have no instance administrator role: they receive `PROJECT_OWNER` on their product
project, `ORG_USER_MANAGER` on the product organization, and the same organization role only on
customer tenants managed by their environment.

FreightClaims has one dedicated migration service account with `PROJECT_OWNER` on the FreightClaims
project, `ORG_USER_MANAGER` on the FreightClaims organization, and `IAM_ORG_MANAGER` so it can
create legacy tenant organizations. It receives neither `IAM_OWNER` nor general user-management
permission across the instance. The disposable local account additionally receives
`IAM_LOGIN_CLIENT` solely for the bounded imported-password verification test.

## Legacy password migration

ZITADEL is configured with the `argon2` password verifier. The FreightClaims migrator sends the
Argon2id PHC string to `POST /v2/users/new` as `hashedPassword.hash` and sets
`changeRequired: true`. The bounded migrator decrypts the legacy credential only in a no-swap,
no-core-dump tmpfs process, immediately hashes it, and never logs or persists the plaintext. The
FreightClaims runtime never receives the legacy password.

The contract was verified against ZITADEL v4.16.2:

1. the FreightClaims Argon2id PHC was accepted unchanged;
2. the old password authenticated;
3. ZITADEL required an immediate password change;
4. external role assignments gave the same product-owned user different access in multiple
   customer organizations.

ZITADEL rehashes a verified legacy password using its active password hasher.

## Branding and email

ZITADEL owns instance and product login branding. Each product project enforces its
owner organization's branding from the first login screen. Each application uses its product's
`auth_origin` as its Login V2 base URI while `auth.ensombl.io` remains the only issuer. Product
Login V2 hosts are instance trusted domains; the stock Login V2 proxy sends the canonical instance
host separately from the browser-facing product host. The instance-wide Login V2 override stays
disabled so ZITADEL honors those per-application hosts; the Management Console is explicitly pinned
to the canonical host.

ZITADEL system notifications use `Ensombl <noreply@notifications.ensombl.io>` through Resend SMTP
with authenticated STARTTLS on port 587. The one-shot catalog bootstrap applies the active provider
through ZITADEL's Admin API so an existing instance receives the same configuration as a fresh
instance. Product-initiated invitations are sent by the initiating product with its configured From
name; generic account recovery has no product context and intentionally uses the Ensombl default.

## Runtime and secrets

The hosted stack contains only ZITADEL, Login V2, a one-shot Bitwarden secret loader, and a one-shot
catalog bootstrap. PostgreSQL is a native Dokploy database service. No retired auth database or
second runtime path is part of this stack.

Dokploy receives only `BWS_ACCESS_TOKEN` and the non-secret `BWS_PROJECT_ID`. The loader writes the
ZITADEL master key and JSON runtime config to a private volume. ZITADEL itself has no Bitwarden
token or outbound secret-manager access.

No project container image is published. Dokploy builds the two small helper images from the
reviewed source and pulls the pinned upstream ZITADEL images.
