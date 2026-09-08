import { readFile } from "node:fs/promises";
import type { Catalog, Product, ProductApplication } from "./catalog.js";
import { migrationSecretPrefix, rolesForProduct, secretPrefix } from "./catalog.js";
import type { ApplicationRuntime, BwsRuntimeStore, RuntimeConfig } from "./runtime-config.js";
import type { ZitadelClient } from "./zitadel.js";

interface BootstrapOptions {
  readonly existing?: RuntimeConfig;
  readonly bws?: BwsRuntimeStore;
  readonly rotateMissingSecrets: boolean;
}

export async function provisionLocalHumans(
  client: ZitadelClient,
  users: NonNullable<Product["local_fixture"]>["users"],
  projectId: string,
  ownerOrganizationId: string,
): Promise<NonNullable<RuntimeConfig["products"][string]["localFixture"]>["users"]> {
  const runtimeUsers: NonNullable<RuntimeConfig["products"][string]["localFixture"]>["users"] = {};
  for (const user of users) {
    const existingUser = await client.getUser(user.id);
    if (!existingUser) {
      await client.createHumanUser({
        organizationId: ownerOrganizationId,
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
        password: user.password,
        passwordChangeRequired: user.password_change_required,
      });
    } else if (
      existingUser.username !== user.email ||
      existingUser.email !== user.email ||
      existingUser.displayName !== user.display_name
    ) {
      await client.updateHumanUser({
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
      });
    }
    await client.ensureAuthorization({
      userId: user.id,
      projectId,
      organizationId: ownerOrganizationId,
      roleKeys: user.roles,
    });
    runtimeUsers[user.key] = { userId: user.id, email: user.email };
  }
  return runtimeUsers;
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
  await bws.set(`${prefix}_MANAGEMENT_CLIENT_ID`, runtime.managementServiceAccount.clientId);
  await bws.set(
    `${prefix}_MANAGEMENT_CLIENT_SECRET`,
    runtime.managementServiceAccount.clientSecret,
  );
}

async function persistMigrationServiceAccount(
  bws: BwsRuntimeStore | undefined,
  product: Product,
  account: NonNullable<RuntimeConfig["products"][string]["migrationServiceAccount"]>,
): Promise<void> {
  if (!bws) return;
  const prefix = migrationSecretPrefix(product);
  await bws.set(`${prefix}_CLIENT_ID`, account.clientId);
  await bws.set(`${prefix}_CLIENT_SECRET`, account.clientSecret);
}

async function readBrandingLogo(path: string | undefined): Promise<Uint8Array | undefined> {
  if (!path) return undefined;
  const encoded = (await readFile(path, "utf8")).replaceAll(/\s+/gu, "");
  const logo = Buffer.from(encoded, "base64");
  if (logo.length === 0) throw new Error(`Branding logo is empty: ${path}`);
  return logo;
}

export async function bootstrapCatalog(
  client: ZitadelClient,
  catalog: Catalog,
  options: BootstrapOptions,
): Promise<RuntimeConfig> {
  const organizations = await client.listOrganizations();
  const projects = await client.listProjects();
  const runtime: RuntimeConfig = {
    issuer: catalog.issuer,
    consoleUrl: new URL(catalog.console_path, catalog.issuer).toString(),
    products: {},
  };
  const obsoleteGeneratedDomainSuffix = `.${new URL(catalog.issuer).hostname}`;

  const instanceOrganization = organizations.find(
    (organization) => organization.name === catalog.instance_organization.name,
  );
  if (!instanceOrganization) {
    throw new Error(
      `Initial organization ${catalog.instance_organization.name} does not exist in ZITADEL`,
    );
  }
  await client.ensurePrimaryOrganizationDomain(
    instanceOrganization.id,
    catalog.instance_organization.domain,
    obsoleteGeneratedDomainSuffix,
  );
  for (const trustedDomain of new Set(
    catalog.products.map((product) => new URL(product.auth_origin).hostname),
  )) {
    await client.addTrustedDomain(trustedDomain);
  }

  const consoleApplication = await client.findApplicationByName("Management Console");
  const consoleProject = projects.find(
    (project) => project.projectId === consoleApplication?.projectId,
  );
  if (!consoleApplication || !consoleProject) {
    throw new Error("ZITADEL Management Console application does not exist");
  }
  await client.configureOidcApplicationLogin({
    ...consoleApplication,
    organizationId: consoleProject.organizationId,
    loginBaseUri: new URL("/ui/v2/login/", catalog.issuer).toString(),
  });
  for (const product of catalog.products) {
    const loginBaseUri = new URL("/ui/v2/login/", product.auth_origin).toString();
    let ownerOrganization = organizations.find(
      (organization) => organization.name === product.owner_organization.name,
    );
    if (!ownerOrganization) {
      ownerOrganization = await client.createOrganization(product.owner_organization.name);
      organizations.push(ownerOrganization);
    }
    await client.ensurePrimaryOrganizationDomain(
      ownerOrganization.id,
      product.owner_organization.domain,
      obsoleteGeneratedDomainSuffix,
    );
    await client.applyBranding(
      ownerOrganization.id,
      product.branding,
      await readBrandingLogo(product.branding.logo_base64_file),
    );
    await client.ensureLoginPolicy(ownerOrganization.id, product.login_policy);

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
    const desiredRoles = rolesForProduct(catalog, product);
    await client.configureProject(projectId, desiredRoles.length > 0);

    const roles = await client.listProjectRoles(projectId);
    const desiredRoleKeys = new Set(desiredRoles.map((role) => role.key));
    for (const role of roles) {
      if (!desiredRoleKeys.has(role.key)) {
        await client.removeProjectRole(projectId, role.key);
      }
    }
    for (const role of desiredRoles) {
      const current = roles.find((candidate) => candidate.key === role.key);
      if (!current) {
        await client.addProjectRole(projectId, role.key, role.display_name);
      } else if (current.displayName !== role.display_name) {
        throw new Error(
          `Role ${product.id}/${role.key} exists with display name "${current.displayName}"`,
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
          loginBaseUri,
          roleAssertion: desiredRoles.length > 0,
        });
        applicationRuntime = {
          ...created,
          baseUrl: application.base_url,
          managementServiceAccount: {
            userId: "",
            clientId: "",
            clientSecret: "",
          },
        };
      } else {
        await client.configureOidcApplication({
          applicationId: current.applicationId,
          projectId,
          organizationId: ownerOrganization.id,
          baseUrl: application.base_url,
          developmentMode: application.development_mode,
          loginBaseUri,
          roleAssertion: desiredRoles.length > 0,
        });
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
          managementServiceAccount: {
            userId: "",
            clientId: "",
            clientSecret: "",
          },
        };
      }

      const account = application.management_service_account;
      const existingAccount = await client.getUser(account.id);
      if (!existingAccount) {
        await client.createServiceAccount({
          organizationId: ownerOrganization.id,
          userId: account.id,
          username: account.username,
          displayName: account.display_name,
        });
      }
      const previousManagementSecret =
        existingApplication?.managementServiceAccount?.clientSecret ??
        options.bws?.get(`${secretPrefix(product, application)}_MANAGEMENT_CLIENT_SECRET`);
      let managementClientSecret = existingAccount ? previousManagementSecret : undefined;
      if (!existingAccount || (!managementClientSecret && options.rotateMissingSecrets)) {
        managementClientSecret = await client.generateServiceAccountSecret(account.id);
      }
      if (!managementClientSecret) {
        throw new Error(
          `Client secret is missing for management service account ` +
            `${product.id}/${application.environment}. Set ` +
            `ZITADEL_ROTATE_MISSING_CLIENT_SECRETS=true once to rotate it.`,
        );
      }
      if (product.instance_org_user_lookup && ownerOrganization.id !== instanceOrganization.id) {
        await client.ensureAdministrator({
          userId: account.id,
          resource: { organizationId: instanceOrganization.id },
          roles: ["ORG_OWNER_VIEWER"],
        });
      } else {
        await client.deleteAdministrator({
          userId: account.id,
          resource: { organizationId: instanceOrganization.id },
        });
      }
      if (ownerOrganization.id !== instanceOrganization.id) {
        await client.ensureAdministrator({
          userId: account.id,
          resource: { organizationId: ownerOrganization.id },
          roles: ["ORG_USER_MANAGER"],
        });
      }
      await client.deleteAdministrator({ userId: account.id, resource: { projectId } });
      await client.deleteAdministrator({
        userId: account.id,
        resource: { instance: true },
      });
      applicationRuntime.managementServiceAccount = {
        userId: account.id,
        clientId: account.username,
        clientSecret: managementClientSecret,
      };

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

    const migrationAccount = product.migration_service_account;
    if (migrationAccount) {
      const existingAccount = await client.getUser(migrationAccount.id);
      if (!existingAccount) {
        await client.createServiceAccount({
          organizationId: ownerOrganization.id,
          userId: migrationAccount.id,
          username: migrationAccount.username,
          displayName: migrationAccount.display_name,
        });
      }
      const previousSecret =
        existingProduct?.migrationServiceAccount?.clientSecret ??
        options.bws?.get(`${migrationSecretPrefix(product)}_CLIENT_SECRET`);
      let clientSecret = existingAccount ? previousSecret : undefined;
      if (!existingAccount || (!clientSecret && options.rotateMissingSecrets)) {
        clientSecret = await client.generateServiceAccountSecret(migrationAccount.id);
      }
      if (!clientSecret) {
        throw new Error(
          `Client secret is missing for migration service account ${product.id}. Set ` +
            `ZITADEL_ROTATE_MISSING_CLIENT_SECRETS=true once to rotate it.`,
        );
      }
      await client.deleteAdministrator({
        userId: migrationAccount.id,
        resource: { projectId },
      });
      if (migrationAccount.verify_imported_passwords) {
        await client.ensureAdministrator({
          userId: migrationAccount.id,
          resource: { instance: true },
          roles: ["IAM_LOGIN_CLIENT"],
        });
      } else {
        await client.deleteAdministrator({
          userId: migrationAccount.id,
          resource: { instance: true },
        });
      }
      await client.ensureAdministrator({
        userId: migrationAccount.id,
        resource: { organizationId: ownerOrganization.id },
        roles: ["ORG_USER_MANAGER"],
      });
      productRuntime.migrationServiceAccount = {
        userId: migrationAccount.id,
        clientId: migrationAccount.username,
        clientSecret,
      };
      await persistMigrationServiceAccount(
        options.bws,
        product,
        productRuntime.migrationServiceAccount,
      );
    }

    if (product.local_fixture) {
      const fixture = product.local_fixture;
      const localUsers = await provisionLocalHumans(
        client,
        fixture.users,
        projectId,
        ownerOrganization.id,
      );
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
        let clientSecret = existingAccount ? previousSecret : undefined;
        if (!existingAccount || (!clientSecret && options.rotateMissingSecrets)) {
          clientSecret = await client.generateServiceAccountSecret(account.id);
        }
        if (!clientSecret) {
          throw new Error(
            `Client secret is missing for local service account ${product.id}/${account.username}. ` +
              `Set ZITADEL_ROTATE_MISSING_CLIENT_SECRETS=true once to rotate it.`,
          );
        }
        if (account.roles.length > 0) {
          await client.ensureAuthorization({
            userId: account.id,
            projectId,
            organizationId: ownerOrganization.id,
            roleKeys: account.roles,
          });
        }
        serviceAccounts[account.username] = {
          userId: account.id,
          clientId: account.username,
          clientSecret,
        };
      }
      productRuntime.localFixture = {
        tenantId: fixture.tenant.id,
        users: localUsers,
      };
    }

    runtime.products[product.id] = productRuntime;
  }

  await client.disableInstanceLoginV2Override();
  return runtime;
}
