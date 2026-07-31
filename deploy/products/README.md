# Product catalog

`products.json` is the hosted catalog and `products.local.json` is the disposable local subset.

Each product declares:

- its product-owner organization and login branding;
- whether roles inherit, extend, or replace `member`, `admin`, and `owner`;
- one OIDC BFF application per canonical `local`, `staging`, or `production` environment;
- one management service account per application, with `PROJECT_OWNER` on only that product
  project and `ORG_USER_MANAGER` only on its tenant organizations;
- an optional migration service account for products that must create tenant organizations;
- optional disposable local human and service-account fixtures for product integration tests.

A migration account is an explicitly trusted control-plane identity, not an application runtime.
It receives `IAM_ORG_MANAGER` because ZITADEL requires an instance permission to create a new
organization. The bootstrap never gives an application management account an instance role.

The catalog bootstraps a clean ZITADEL instance. There is no compatibility or repair workflow:
before a greenfield hosted reset, clear the dedicated auth database and generated product secrets,
then run the bootstrap once.
