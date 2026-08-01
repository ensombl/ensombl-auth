# Roles and permissions

ZITADEL has two unrelated role systems. Keeping them separate is a hard architecture rule.

## ZITADEL project roles

Project roles are application-defined role keys. ZITADEL stores their assignments, can require an
assignment before login, and asserts assignments in OIDC token or Userinfo claims. ZITADEL does
not interpret the business meaning of a role; the product must enforce it.

A role assignment binds four values:

1. one user or service account;
2. one project;
3. one organization context; and
4. one or more project role keys.

The organization context is what makes the same person a `tenant_admin` in one customer tenant and
a `member` in another. The resulting claim maps every role to the organization IDs in which it is
valid.

## ZITADEL administrator roles

Administrator roles authorize changes to ZITADEL itself. They are not FreightClaims or
FreightCheck application roles and are not treated as application role claims.

| Scope | Examples | Meaning |
| --- | --- | --- |
| Instance | `IAM_OWNER`, `IAM_ORG_MANAGER` | Administer the whole identity instance or create organizations |
| Organization | `ORG_OWNER`, `ORG_USER_MANAGER` | Administer one ZITADEL organization or its users |
| Project | `PROJECT_OWNER` | Administer one project's apps, grants, and role assignments |

An `IAM_OWNER` can administer the entire identity instance. It does not automatically receive
access to product tenant data. Human instance ownership is reserved for named Ensombl operators.
Product runtime accounts never receive it.

## Ensombl product model

Every product has one owner organization. The owner organization owns the project's applications,
service accounts, and each human identity created for that product. A human is created once even
when they use many customer tenants.

For a multi-tenant product:

1. each customer tenant is a ZITADEL organization;
2. the product project is granted to that organization with the allowed role keys;
3. the product-owned human receives an external role assignment in that tenant organization; and
4. the token contains the tenant organization ID beside the assigned role.

The OIDC request pins the product owner organization so another product's users cannot enter the
login flow. It does not limit returned project roles to that organization; all granted
organization assignments for the project are asserted.

The product catalog owns only the finite role vocabulary and static product resources. Dynamic
customer organizations, project grants, and assignments are created by the product's normal tenant
and membership workflows.

## FreightClaims

FreightClaims completely replaces the default role vocabulary:

| Role | Scope | Purpose |
| --- | --- | --- |
| `member` | Tenant | Standard tenant access |
| `adjuster` | Tenant | Claims operations |
| `tenant_admin` | Tenant | Tenant user and configuration administration |
| `platform_support` | Tenant | Audited support access to an explicitly assigned tenant |
| `platform_admin` | Tenant | Elevated platform operations in an explicitly assigned tenant |
| `partner_api` | Tenant | Partner machine access |
| `tai_api` | Tenant | TAI machine access |

PostgreSQL stores the matching user-to-tenant membership because application joins and row-level
security must be enforceable without a network call to ZITADEL. The API accepts a tenant only when
the signed ZITADEL role and the PostgreSQL membership agree exactly. Either side missing or
disagreeing fails closed.

The FreightClaims membership API is the only normal write path. It updates ZITADEL and PostgreSQL
in an order that never creates usable access from a partial write. Direct Console edits are for
operators and cannot bypass PostgreSQL RLS; there is no background role reconciler.

## Catalog defaults

The catalog default is `member`, `admin`, and `owner`. A product may inherit it, extend it, or
replace it. The catalog bootstrap makes the project's role vocabulary exactly match that resolved
set, removing obsolete roles and their dependent role assignments.

These names still have only product-defined meaning. A project role named `owner` is not
`ORG_OWNER`, `PROJECT_OWNER`, or `IAM_OWNER`.

## ZITADEL references

- [Projects, roles, role assignments, and project grants](https://zitadel.com/docs/guides/manage/console/projects-overview)
- [B2B organizations and external role assignments](https://zitadel.com/docs/guides/solution-scenarios/b2b)
- [External user role assignments](https://zitadel.com/docs/concepts/features/external-user-grant)
- [OIDC organization and role scopes](https://zitadel.com/docs/apis/openidoauth/scopes)
