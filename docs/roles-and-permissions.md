# Roles and permissions

ZITADEL administrator roles and optional project roles are separate concepts. They must not be
used interchangeably. Consumer authorization is outside this repository.

## ZITADEL project roles

Project roles are optional product-defined claims. The catalog has no default roles. Products may
declare their own roles independently. When a product declares roles, bootstrap enables role claims
without requiring a role assignment for login. Bootstrap never assigns project roles implicitly.

## ZITADEL administrator roles

Administrator roles authorize management of ZITADEL itself. They never grant product data access.

| Scope | Examples | Meaning |
| --- | --- | --- |
| Instance | `IAM_OWNER`, `IAM_LOGIN_CLIENT` | Administer the instance or perform a narrowly scoped instance operation |
| Organization | `ORG_OWNER`, `ORG_USER_MANAGER` | Administer a product identity organization or its users |
| Project | `PROJECT_OWNER` | Administer one project's apps and optional project roles |

Human instance ownership is reserved for named Ensombl operators. Product runtime accounts receive
`ORG_USER_MANAGER` on their product organization. A product that sets `instance_org_user_lookup`
in the catalog also gives its management accounts `ORG_OWNER_VIEWER` (read only) on the instance
organization, so the product can resolve identities owned by named Ensombl operators who also use
that product; this stays an organization role, not an `IAM_*` instance role. Product runtime and
migration accounts are not project administrators.

## Product boundary

Every product has one owner organization. It owns the product project, OIDC applications, service
accounts, login branding, and the human identities created for that product. A named Ensombl
operator keeps a single identity in the instance organization and may still be admitted to a
product that sets `instance_org_user_lookup`; the product reads that identity but never owns or
modifies it. Consumer application tenancy is not represented by ZITADEL organizations.

The OIDC request pins the product owner organization so another product's identities cannot enter
that product's login flow. The canonical issuer remains `https://auth.ensombl.io`.

## ZITADEL references

- [Projects and project roles](https://zitadel.com/docs/guides/manage/console/projects-overview)
- [Administrator roles](https://zitadel.com/docs/guides/manage/console/administrators)
- [OIDC organization scopes](https://zitadel.com/docs/apis/openidoauth/scopes)
