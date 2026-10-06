# Architecture

## Identity and tenancy model

One ZITADEL instance is the FreightCheck identity service. Each product organization owns the
identities admitted to that product. Customer tenancy is application data and is not represented
by ZITADEL organizations.

| Ensombl concept | ZITADEL object |
| --- | --- |
| Global identity platform | Instance |
| Product identity owner and product branding | Product owner organization |
| FreightCheck | Project |
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
`freightcheck.io` domain primary for the FreightCheck product owner.
Bootstrap removes the automatic `<organization>.auth.freightcheck.io` domains generated from ZITADEL's
external hostname.

Products have no default ZITADEL project roles. Each product may independently declare roles in the
catalog. Bootstrap enables role claims when roles exist, does not require a role for login, and does
not assign roles implicitly.

## Authentication

Products use Authorization Code with PKCE through a confidential BFF client. The canonical issuer
is `https://auth.freightcheck.io`. The signed subject identifies the human. Each product resolves that
subject to its own memberships and establishes an RLS context; authentication alone never grants
tenant data access.

Machine clients use ZITADEL API applications and standard token introspection. Product management
uses the environment's declared ZITADEL service account and short-lived client-credentials access
tokens. The initial IAM-owner PAT exists only inside the auth stack to apply the declarative
catalog and is mounted from the private bootstrap volume. Product workloads never receive it.

ZITADEL Console access uses built-in administrator permissions, not product project roles. The
configured initial administrator owns instance bootstrap. Product management service accounts have
no instance administrator role. They receive `ORG_USER_MANAGER` on the product organization so they
can invite and manage product identities; a product that sets `instance_org_user_lookup` in the
catalog also gives its management accounts `ORG_OWNER_VIEWER` (read only) on the instance
organization, so the product can resolve — but never modify — identities owned by named Ensombl
operators who also use that product. This stays an organization role — the accounts still hold no
`IAM_*` instance role. Declaring global project roles never grants a runtime or migration account
project administration; role definitions and assignments remain explicit control-plane operations.

FreightCheck has one dedicated migration service account with `ORG_USER_MANAGER` on its own
organization. It receives neither `IAM_OWNER`, `IAM_ORG_MANAGER`, nor instance-wide user
management. It creates users without importing legacy passwords, so it receives no
`IAM_LOGIN_CLIENT` grant. Each application also has a dedicated invitation service account
with `ORG_USER_MANAGER` only on the FreightCheck organization.

## Branding and email

ZITADEL owns instance and product login branding. Each product project enforces its
owner organization's branding from the first login screen. Each application uses its product's
`auth_origin` as its Login V2 base URI while `auth.freightcheck.io` remains the only issuer. Product
Login V2 hosts are instance trusted domains; the stock Login V2 proxy sends the canonical instance
host separately from the browser-facing product host. The instance-wide Login V2 override stays
disabled so ZITADEL honors those per-application hosts; the Management Console is explicitly pinned
to the canonical host.

FreightCheck enables username/password login, password recovery, and self-registration.
Its purple palette, light/dark colors, logo, icon, and privacy/help links apply to both the
instance and product organization in hosted and local setup. Applications never collect
credentials themselves; FreightCheck retains application-level invitation and membership consent.

ZITADEL system notifications use `FreightCheck <noreply@notifications.ensombl.io>` through Resend SMTP
with authenticated STARTTLS on port 587. The one-shot catalog bootstrap applies the active provider
through ZITADEL's Admin API so an existing instance receives the same configuration as a fresh
instance. ZITADEL sends every message, invitations included, from that sender: `email_from_name`
in the catalog is not applied to ZITADEL mail, and the sender is an instance setting that no
organization can override. A product that invites a user controls the wording and the link, not the
sender: it passes `applicationName` and a `urlTemplate` with the `invite_code` request. Generic
account recovery has no product context and intentionally uses the FreightCheck default.

A user who finishes a flow ZITADEL did not start from an OIDC request, such as activating an
invitation, is sent to the product organization's login-policy `defaultRedirectUri`; without one
ZITADEL leaves them on its Console. The catalog's `login_policy.default_redirect_uri` sets it and
must sit under one of the product's applications. An organization has one value, so a product with
a staging and a production application picks one.

## Runtime and secrets

The hosted stack contains ZITADEL, Login V2, a one-shot Bitwarden secret loader, and a one-shot
catalog bootstrap. PostgreSQL is a native Dokploy database service.

Dokploy receives only `BWS_ACCESS_TOKEN` and the non-secret `BWS_PROJECT_ID`. The loader writes the
ZITADEL master key and JSON runtime config to a private volume. ZITADEL itself has no Bitwarden
token or outbound secret-manager access.

No project container image is published. Dokploy builds the two small helper images from the
reviewed source and pulls the pinned upstream ZITADEL images.
