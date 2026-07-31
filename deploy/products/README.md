# Product catalog

`products.json` is the hosted catalog and `products.local.json` is the disposable local subset.

Each product declares:

- its product-owner organization and login branding;
- whether roles inherit, extend, or replace `member`, `admin`, and `owner`;
- one OIDC BFF application per canonical `local`, `staging`, or `production` environment;
- one management service account per application, with the declared instance roles and
  `PROJECT_OWNER` on only that product project;
- optional disposable local human and service-account fixtures for product integration tests.

The catalog bootstraps a clean ZITADEL instance. There is no compatibility or repair workflow:
before a greenfield hosted reset, clear the dedicated auth database and generated product secrets,
then run the bootstrap once.
