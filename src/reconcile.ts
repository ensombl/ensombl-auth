import type { Catalog, Product, ProductApplication } from "./catalog.js";
import { rolesForProduct, secretPrefix } from "./catalog.js";
import type { ApplicationRuntime, BwsRuntimeStore, RuntimeConfig } from "./runtime-config.js";
import type { ZitadelClient } from "./zitadel.js";

interface ReconcileOptions {
  readonly existing?: RuntimeConfig;
  readonly bws?: BwsRuntimeStore;
  readonly rotateMissingSecrets: boolean;
}

function findProductRuntime(
  existing: RuntimeConfig | undefined,
  productId: string,
): RuntimeConfig["products"][string] | undefined {
  return existing?.products[productId];
}

async function persistApplication(
  bws: BwsRuntimeStore | undefined,
  product: Product,
  application: ProductApplication,
  projectId: string,
  ownerOrganizationId: string,
  runtime: ApplicationRuntime,
): Promise<void> {
  if (!bws) return;
  const prefix = secretPrefix(product, application);
  await bws.set(`${prefix}_PROJECT_ID`, projectId);
  await bws.set(`${prefix}_OWNER_ORGANIZATION_ID`, ownerOrganizationId);
  await bws.set(`${prefix}_APPLICATION_ID`, runtime.applicationId);
  await bws.set(`${prefix}_CLIENT_ID`, runtime.clientId);
  await bws.set(`${prefix}_CLIENT_SECRET`, runtime.clientSecret);
}

export async function reconcileCatalog(
  client: ZitadelClient,
  catalog: Catalog,
  options: ReconcileOptions,
): Promise<RuntimeConfig> {
  const organizations = await client.listOrganizations();
  const projects = await client.listProjects();
  const runtime: RuntimeConfig = {
    issuer: catalog.issuer,
    consoleUrl: new URL(catalog.console_path, catalog.issuer).toString(),
    products: {},
  };

  for (const product of catalog.products) {
    let ownerOrganization = organizations.find(
      (organization) => organization.name === product.owner_organization.name,
    );
    if (!ownerOrganization) {
      ownerOrganization = await client.createOrganization(product.owner_organization.name);
      organizations.push(ownerOrganization);
    }
    await client.addOrganizationDomain(ownerOrganization.id, product.owner_organization.domain);
    await client.applyBranding(ownerOrganization.id, product.branding);

    let projectId = projects.find(
      (project) =>
        project.organizationId === ownerOrganization.id &&
        project.name === product.display_name &&
        project.grantedOrganizationId === undefined,
    )?.projectId;
    if (!projectId) {
      projectId = await client.createProject(ownerOrganization.id, product.display_name);
      projects.push({
        projectId,
        organizationId: ownerOrganization.id,
        name: product.display_name,
      });
    }
    await client.configureProject(projectId);

    const roles = await client.listProjectRoles(projectId);
    const desiredRoles = rolesForProduct(catalog, product);
    for (const role of desiredRoles) {
      const current = roles.find((candidate) => candidate.key === role.key);
      if (!current) {
        await client.addProjectRole(projectId, role.key, role.display_name);
      } else if (current.displayName !== role.display_name) {
        throw new Error(
          `Role ${product.id}/${role.key} exists with display name "${current.displayName}"; ` +
            `update it in the ZITADEL Console before reconciling`,
        );
      }
    }

    const existingProduct = findProductRuntime(options.existing, product.id);
    const applications = await client.listApplications(projectId);
    const productRuntime: RuntimeConfig["products"][string] = {
      projectId,
      ownerOrganizationId: ownerOrganization.id,
      applications: {},
    };

    for (const application of product.applications) {
      const current = applications.find((candidate) => candidate.name === application.name);
      const existingApplication = existingProduct?.applications[application.environment];
      let applicationRuntime: ApplicationRuntime;

      if (!current) {
        const created = await client.createOidcApplication({
          projectId,
          name: application.name,
          baseUrl: application.base_url,
          developmentMode: application.development_mode,
        });
        applicationRuntime = {
          ...created,
          baseUrl: application.base_url,
        };
      } else {
        const prefix = secretPrefix(product, application);
        const persistedSecret =
          existingApplication?.clientSecret ?? options.bws?.get(`${prefix}_CLIENT_SECRET`);
        let clientSecret = persistedSecret;
        if (!clientSecret && options.rotateMissingSecrets) {
          clientSecret = await client.rotateClientSecret(current.applicationId, projectId);
        }
        if (!clientSecret) {
          throw new Error(
            `Client secret is missing for existing application ${product.id}/${application.environment}. ` +
              `Set ZITADEL_ROTATE_MISSING_CLIENT_SECRETS=true once to rotate and persist it.`,
          );
        }
        if (!current.oidcConfiguration?.clientId) {
          throw new Error(`${product.id}/${application.environment} is not an OIDC application`);
        }
        applicationRuntime = {
          applicationId: current.applicationId,
          clientId: current.oidcConfiguration.clientId,
          clientSecret,
          baseUrl: application.base_url,
        };
      }

      productRuntime.applications[application.environment] = applicationRuntime;
      await persistApplication(
        options.bws,
        product,
        application,
        projectId,
        ownerOrganization.id,
        applicationRuntime,
      );
    }

    if (product.local_fixture) {
      const fixture = product.local_fixture;
      let tenant = organizations.find(
        (organization) =>
          organization.id === fixture.tenant.id || organization.name === fixture.tenant.name,
      );
      if (!tenant) {
        tenant = await client.createOrganization(fixture.tenant.name, fixture.tenant.id);
        organizations.push(tenant);
      }
      if (tenant.id !== fixture.tenant.id) {
        throw new Error(
          `Local fixture organization ${fixture.tenant.name} exists with unexpected ID ${tenant.id}`,
        );
      }
      await client.addOrganizationDomain(tenant.id, fixture.tenant.domain);
      await client.applyBranding(tenant.id, fixture.tenant.branding ?? product.branding);
      await client.ensureProjectGrant(
        projectId,
        tenant.id,
        desiredRoles.map((role) => role.key),
      );

      const existingUser = await client.getUser(fixture.user.id);
      if (!existingUser) {
        await client.createHumanUser({
          organizationId: tenant.id,
          userId: fixture.user.id,
          email: fixture.user.email,
          displayName: fixture.user.display_name,
          password: fixture.user.password,
          passwordChangeRequired: false,
        });
      }
      await client.ensureAuthorization({
        userId: fixture.user.id,
        projectId,
        organizationId: tenant.id,
        roleKeys: [fixture.user.role],
      });
      const serviceAccounts: NonNullable<RuntimeConfig["products"][string]["serviceAccounts"]> = {};
      if (fixture.service_accounts.length > 0) productRuntime.serviceAccounts = serviceAccounts;
      for (const account of fixture.service_accounts) {
        const existingAccount = await client.getUser(account.id);
        if (!existingAccount) {
          await client.createServiceAccount({
            organizationId: ownerOrganization.id,
            userId: account.id,
            username: account.username,
            displayName: account.display_name,
          });
        }
        const previousSecret = existingProduct?.serviceAccounts?.[account.username]?.clientSecret;
        let clientSecret = previousSecret;
        if (!clientSecret && options.rotateMissingSecrets) {
          clientSecret = await client.generateServiceAccountSecret(account.id);
        }
        if (!clientSecret) {
          throw new Error(
            `Client secret is missing for local service account ${product.id}/${account.username}. ` +
              `Set ZITADEL_ROTATE_MISSING_CLIENT_SECRETS=true once to rotate it.`,
          );
        }
        await client.ensureAuthorization({
          userId: account.id,
          projectId,
          organizationId: tenant.id,
          roleKeys: [account.role],
        });
        serviceAccounts[account.username] = {
          userId: account.id,
          clientId: account.username,
          clientSecret,
          role: account.role,
        };
      }
      productRuntime.localFixture = {
        tenantOrganizationId: tenant.id,
        userId: fixture.user.id,
        email: fixture.user.email,
        role: fixture.user.role,
      };
    }

    runtime.products[product.id] = productRuntime;
  }

  return runtime;
}
