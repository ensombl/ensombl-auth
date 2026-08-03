# Roles and permissions

ZITADEL administrator roles, optional project roles, and application tenant roles are separate
concepts. They must not be used interchangeably.

## Application tenant roles

Each product database is the authority for customer tenants, memberships, roles, permissions, and
row-level security. One signed ZITADEL subject may therefore be a member of several tenants and
hold a different role in each tenant without creating a ZITADEL organization or authorization for
every membership.

FreightClaims uses `viewer`, `member`, `admin`, and `owner` as its application-owned tenant roles.
Claim scope and work-queue assignment remain separate application concerns. Partner and TAI
machine access is bound by the ZITADEL client ID to a tenant-scoped database client record and
kind. FreightCheck owns its own tenant-role vocabulary in its database.

ZITADEL proves who or which machine authenticated. The product database decides what that subject
or client may do in a selected tenant. Successful login never grants tenant access by itself.

## ZITADEL project roles

Project roles are optional application-defined claims. The catalog has no default roles. A product
may declare a project role only for genuinely product-wide, cross-tenant authority that belongs in
the identity token. It must not declare customer membership roles there.

FreightClaims declares `platform_support` and `platform_admin` for audited product-wide operations.
Its OIDC applications assert those roles when explicitly assigned, but role assignment is not
required for ordinary login. FreightCheck currently declares no project roles.

Product management and migration service accounts do not receive `PROJECT_OWNER`. Declaring a
project role never promotes a runtime account into project administration. Platform-role
assignments are explicit administrative actions.

## ZITADEL administrator roles

Administrator roles authorize management of ZITADEL itself. They never grant product data access.

| Scope | Examples | Meaning |
| --- | --- | --- |
| Instance | `IAM_OWNER`, `IAM_LOGIN_CLIENT` | Administer the instance or perform a narrowly scoped instance operation |
| Organization | `ORG_OWNER`, `ORG_USER_MANAGER` | Administer a product identity organization or its users |
| Project | `PROJECT_OWNER` | Administer one project's apps and optional project roles |

An `IAM_OWNER` can administer the identity instance but does not automatically receive access to
any FreightClaims or FreightCheck tenant. Human instance ownership is reserved for named Ensombl
operators. Product runtime accounts receive `ORG_USER_MANAGER` only on their product organization;
runtime products do not require project administration.

## Product boundary

Every product has one owner organization. It owns the product project, OIDC applications, service
accounts, login branding, and human identities admitted to that product. Customer tenants never
appear as ZITADEL organizations. Tenant creation and membership changes are normal product database
transactions protected by RLS.

The OIDC request pins the product owner organization so another product's identities cannot enter
that product's login flow. The canonical issuer remains `https://auth.ensombl.io`.

## ZITADEL references

- [Projects and project roles](https://zitadel.com/docs/guides/manage/console/projects-overview)
- [Administrator roles](https://zitadel.com/docs/guides/manage/console/administrators)
- [OIDC organization scopes](https://zitadel.com/docs/apis/openidoauth/scopes)
