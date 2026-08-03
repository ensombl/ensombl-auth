# Architecture

## Identity and tenancy model

One ZITADEL instance is the global Ensombl identity service. Each product organization owns the
identities admitted to that product. Customer tenancy is application data and is not represented
by ZITADEL organizations.

| Ensombl concept | ZITADEL object |
| --- | --- |
| Global identity platform | Instance |
| Product identity owner and product branding | Product owner organization |
| FreightClaims or FreightCheck | Project |
| Local, staging, or production BFF | OIDC application |
| Human admitted to a product | User in the product organization |
| Customer tenant, membership, and role | Product database |
| Tenant data isolation | Product database RLS |
| Admin UI | ZITADEL Console |

Product projects are owned by dedicated product organizations. Enforcing project-owner branding
therefore makes the login screen deterministic from the OIDC client before the user is known. The
OIDC request includes the product organization scope, so only identities owned by that product
organization can log in. Customer-tenant selection and branding belong to the product UI.

Organization domains are identity-discovery and username-suffix domains, not service hostnames.
The catalog makes `ensombl.io` primary for the Ensombl organization and the declared
`freightclaims.com` and `freightcheck.io` domains primary for their respective product owners.
Bootstrap removes the automatic `<organization>.auth.ensombl.io` domains generated from ZITADEL's
external hostname.

Products have no default ZITADEL project roles. Each product may independently declare roles in the
catalog. Bootstrap enables role claims when roles exist, does not require a role for login, and does
not assign roles implicitly.

## Authentication

Products use Authorization Code with PKCE through a confidential BFF client. The canonical issuer
is `https://auth.ensombl.io`. The signed subject identifies the human. Each product resolves that
subject to its own memberships and establishes an RLS context; authentication alone never grants
tenant data access.

Machine clients use ZITADEL API applications and standard token introspection. Product management
uses the environment's declared ZITADEL service account and short-lived client-credentials access
tokens. The initial IAM-owner PAT exists only inside the auth stack to apply the declarative
catalog and is mounted from the private bootstrap volume. Product workloads never receive it.

ZITADEL Console access uses built-in administrator permissions, not product project roles. The
configured initial administrator owns instance bootstrap. Product management service accounts have
no instance administrator role. They receive `ORG_USER_MANAGER` only on the product organization
so they can invite and manage product identities. Declaring global project roles never grants a
runtime or migration account project administration; role definitions and assignments remain
explicit control-plane operations.

FreightClaims has one dedicated migration service account with `ORG_USER_MANAGER` on the
FreightClaims organization. It receives neither `IAM_OWNER`, `IAM_ORG_MANAGER`, nor general
user-management permission across the instance. The disposable local account additionally receives
`IAM_LOGIN_CLIENT` solely for the bounded imported-password verification test.

## Legacy password migration

ZITADEL is configured with the `argon2` password verifier. The FreightClaims migrator sends the
Argon2id PHC string to `POST /v2/users/new` as `hashedPassword.hash` and sets
`changeRequired: true`. The bounded migrator decrypts the legacy credential only in a no-swap,
no-core-dump tmpfs process, immediately hashes it, and never logs or persists the plaintext. The
FreightClaims runtime never receives the legacy password.

An imported Argon2id PHC must authenticate with the legacy password, require an immediate password
change, and preserve the signed subject used by the product database. ZITADEL rehashes a verified
legacy password using its active password hasher.

## Branding and email

ZITADEL owns instance and product login branding. Each product project enforces its
owner organization's branding from the first login screen. Each application uses its product's
`auth_origin` as its Login V2 base URI while `auth.ensombl.io` remains the only issuer. Product
Login V2 hosts are instance trusted domains; the stock Login V2 proxy sends the canonical instance
host separately from the browser-facing product host. The instance-wide Login V2 override stays
disabled so ZITADEL honors those per-application hosts; the Management Console is explicitly pinned
to the canonical host.

Each product declares its native hosted-login policy independently. FreightClaims keeps the
canonical application's username/password and password-recovery behavior, disables public
self-registration and external identity providers, and applies the canonical FreightClaims logo,
green palette, neutral background, and light theme through ZITADEL's organization branding and
asset APIs. Applications never render or collect credentials themselves.

ZITADEL system notifications use `Ensombl <noreply@notifications.ensombl.io>` through Resend SMTP
with authenticated STARTTLS on port 587. The one-shot catalog bootstrap applies the active provider
through ZITADEL's Admin API so an existing instance receives the same configuration as a fresh
instance. Product-initiated invitations are sent by the initiating product with its configured From
name; generic account recovery has no product context and intentionally uses the Ensombl default.

## Runtime and secrets

The hosted stack contains ZITADEL, Login V2, a one-shot Bitwarden secret loader, and a one-shot
catalog bootstrap. PostgreSQL is a native Dokploy database service.

Dokploy receives only `BWS_ACCESS_TOKEN` and the non-secret `BWS_PROJECT_ID`. The loader writes the
ZITADEL master key and JSON runtime config to a private volume. ZITADEL itself has no Bitwarden
token or outbound secret-manager access.

No project container image is published. Dokploy builds the two small helper images from the
reviewed source and pulls the pinned upstream ZITADEL images.
