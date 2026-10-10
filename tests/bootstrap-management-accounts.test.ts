import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bootstrapCatalog } from "../src/bootstrap.js";
import { catalogSchema, loadCatalog } from "../src/catalog.js";
import type { BwsRuntimeStore } from "../src/runtime-config.js";
import type { ZitadelClient } from "../src/zitadel.js";

const branding = {
  primary_color: "#123456",
  warn_color: "#123456",
  background_color: "#123456",
  font_color: "#123456",
  primary_color_dark: "#123456",
  warn_color_dark: "#123456",
  background_color_dark: "#123456",
  font_color_dark: "#123456",
};

const managementServiceAccountId = "01900000-0000-7000-8000-0000000000aa";

function catalogFor(instanceOrgUserLookup: boolean, defaultRedirectUri?: string) {
  return catalogSchema.parse({
    issuer: "https://auth.ensombl.io",
    console_path: "/ui/console",
    instance_organization: { name: "Ensombl", domain: "ensombl.io" },
    email: {
      from_address: "noreply@notifications.ensombl.io",
      default_from_name: "Ensombl",
    },
    products: [
      {
        id: "freightcheck",
        display_name: "FreightCheck",
        auth_origin: "https://auth.freightcheck.io",
        email_from_name: "FreightCheck",
        owner_organization: { name: "FreightCheck", domain: "freightcheck.io" },
        instance_org_user_lookup: instanceOrgUserLookup,
        ...(defaultRedirectUri === undefined
          ? {}
          : { login_policy: { default_redirect_uri: defaultRedirectUri } }),
        branding,
        applications: [
          {
            environment: "staging",
            name: "FreightCheck staging web",
            base_url: "https://app.staging.freightcheck.io",
            management_service_account: {
              id: managementServiceAccountId,
              username: "freightcheck-staging-management",
              display_name: "FreightCheck staging management",
            },
          },
        ],
      },
    ],
  });
}

function mockClient() {
  const ensureAdministrator = vi.fn().mockResolvedValue(undefined);
  const deleteAdministrator = vi.fn().mockResolvedValue(undefined);
  const client = {
    addTrustedDomain: vi.fn().mockResolvedValue(undefined),
    applyBranding: vi.fn().mockResolvedValue(undefined),
    configureOidcApplication: vi.fn().mockResolvedValue(undefined),
    configureOidcApplicationLogin: vi.fn().mockResolvedValue(undefined),
    configureProject: vi.fn().mockResolvedValue(undefined),
    createOidcApplication: vi.fn().mockResolvedValue({
      applicationId: "application-id",
      clientId: "client-id",
      clientSecret: "client-secret",
    }),
    createOrganization: vi
      .fn()
      .mockResolvedValue({ id: "freightcheck-organization-id", name: "FreightCheck" }),
    createProject: vi.fn().mockResolvedValue("freightcheck-project-id"),
    createServiceAccount: vi.fn().mockResolvedValue(undefined),
    deleteAdministrator,
    disableInstanceLoginV2Override: vi.fn().mockResolvedValue(undefined),
    ensureAdministrator,
    ensureLoginPolicy: vi.fn().mockResolvedValue(undefined),
    ensurePrimaryOrganizationDomain: vi.fn().mockResolvedValue(undefined),
    findApplicationByName: vi.fn().mockResolvedValue({
      applicationId: "console-application-id",
      name: "Management Console",
      oidcConfiguration: { clientId: "console-client-id" },
      projectId: "console-project-id",
    }),
    generateServiceAccountSecret: vi.fn().mockResolvedValue("management-secret"),
    getUser: vi.fn().mockResolvedValue(undefined),
    listApplications: vi.fn().mockResolvedValue([]),
    listOrganizations: vi
      .fn()
      .mockResolvedValue([{ id: "ensombl-organization-id", name: "Ensombl" }]),
    listProjectRoles: vi.fn().mockResolvedValue([]),
    listProjects: vi.fn().mockResolvedValue([
      {
        projectId: "console-project-id",
        organizationId: "ensombl-organization-id",
        name: "ZITADEL",
      },
    ]),
  } as unknown as ZitadelClient;
  return { client, ensureAdministrator, deleteAdministrator };
}

const instanceOrgResource = { resource: { organizationId: "ensombl-organization-id" } };

describe("management service account instance-organization grant", () => {
  it("grants read-only ORG_OWNER_VIEWER on the instance organization when instance_org_user_lookup is set", async () => {
    const { client, ensureAdministrator, deleteAdministrator } = mockClient();

    await bootstrapCatalog(client, catalogFor(true), { rotateMissingSecrets: true });

    expect(ensureAdministrator).toHaveBeenCalledWith({
      userId: managementServiceAccountId,
      resource: { organizationId: "ensombl-organization-id" },
      roles: ["ORG_OWNER_VIEWER"],
    });
    expect(ensureAdministrator).toHaveBeenCalledWith({
      userId: managementServiceAccountId,
      resource: { organizationId: "freightcheck-organization-id" },
      roles: ["ORG_USER_MANAGER"],
    });
    expect(deleteAdministrator).not.toHaveBeenCalledWith(
      expect.objectContaining({
        userId: managementServiceAccountId,
        ...instanceOrgResource,
      }),
    );
    expect(deleteAdministrator).toHaveBeenCalledWith({
      userId: managementServiceAccountId,
      resource: { instance: true },
    });
  });

  it("strips any instance-organization membership when instance_org_user_lookup is not set", async () => {
    const { client, ensureAdministrator, deleteAdministrator } = mockClient();

    await bootstrapCatalog(client, catalogFor(false), { rotateMissingSecrets: true });

    expect(deleteAdministrator).toHaveBeenCalledWith({
      userId: managementServiceAccountId,
      resource: { organizationId: "ensombl-organization-id" },
    });
    expect(ensureAdministrator).not.toHaveBeenCalledWith(
      expect.objectContaining({
        userId: managementServiceAccountId,
        ...instanceOrgResource,
      }),
    );
    expect(ensureAdministrator).toHaveBeenCalledWith({
      userId: managementServiceAccountId,
      resource: { organizationId: "freightcheck-organization-id" },
      roles: ["ORG_USER_MANAGER"],
    });
  });
});

describe("login policy default redirect", () => {
  it("hands the product's default redirect URI to the organization's login policy", async () => {
    const { client } = mockClient();

    await bootstrapCatalog(client, catalogFor(false, "https://app.staging.freightcheck.io/"), {
      rotateMissingSecrets: true,
    });

    expect(client.ensureLoginPolicy).toHaveBeenCalledWith(
      "freightcheck-organization-id",
      expect.objectContaining({ default_redirect_uri: "https://app.staging.freightcheck.io/" }),
    );
  });

  it("declares none when the product does not", async () => {
    const { client } = mockClient();

    await bootstrapCatalog(client, catalogFor(false), { rotateMissingSecrets: true });

    expect(client.ensureLoginPolicy).toHaveBeenCalledWith(
      "freightcheck-organization-id",
      expect.not.objectContaining({ default_redirect_uri: expect.anything() }),
    );
  });
});

it("provisions a dedicated invitation account only in the product organization", async () => {
  const { client, ensureAdministrator } = mockClient();
  const catalog = catalogFor(false);
  const application = catalog.products[0]?.applications[0];
  if (!application) throw new Error("Missing fixture application");
  const id = "01900000-0000-7000-8000-0000000000bb";
  application.invitation_service_account = {
    id,
    username: "freightcheck-staging-invitations",
    display_name: "FreightCheck invitations",
  };
  const runtime = await bootstrapCatalog(client, catalog, { rotateMissingSecrets: true });
  expect(ensureAdministrator).toHaveBeenCalledWith({
    userId: id,
    resource: { organizationId: "freightcheck-organization-id" },
    roles: ["ORG_USER_MANAGER"],
  });
  expect(ensureAdministrator).not.toHaveBeenCalledWith(
    expect.objectContaining({ userId: id, resource: { instance: true } }),
  );
  expect(
    runtime.products.freightcheck?.applications.staging?.invitationServiceAccount?.userId,
  ).toBe(id);
});

it.each([
  "products.json",
  "products.local.json",
])("bootstraps only FreightCheck and preserves credentials on a second run from %s", async (fileName) => {
  const catalog = await loadCatalog(`deploy/products/${fileName}`);
  const product = catalog.products[0];
  if (!product) throw new Error("Missing FreightCheck");
  const { client } = mockClient();
  Object.assign(client, {
    addProjectRole: vi.fn(),
    ensureAllowedLanguages: vi.fn(),
    ensureHostedLoginTranslation: vi.fn(),
    ensurePrivacyPolicy: vi.fn(),
    ensureAuthorization: vi.fn(),
    createHumanUser: vi.fn(),
    updateHumanUser: vi.fn(),
  });
  const secrets = new Map<string, string>();
  const bws = {
    get: (key: string) => secrets.get(key),
    set: vi.fn(async (key: string, value: string) => {
      secrets.set(key, value);
    }),
  } as unknown as BwsRuntimeStore;
  const first = await bootstrapCatalog(client, catalog, { bws, rotateMissingSecrets: false });
  expect(Object.keys(first.products)).toEqual(["freightcheck"]);
  expect(client.createOrganization).toHaveBeenCalledExactlyOnceWith("FreightCheck");
  expect(client.createProject).toHaveBeenCalledExactlyOnceWith(
    "freightcheck-organization-id",
    "FreightCheck",
  );
  expect(client.ensurePrivacyPolicy).toHaveBeenCalledWith(
    "freightcheck-organization-id",
    product.privacy_policy,
    true,
  );
  expect(client.ensureAllowedLanguages).toHaveBeenCalledWith(["en"]);
  expect(client.ensureHostedLoginTranslation).toHaveBeenCalledWith(
    "en",
    catalog.hosted_login?.translations.en,
  );
  expect(client.ensureHostedLoginTranslation).toHaveBeenCalledWith(
    "en",
    catalog.hosted_login?.translations.en,
    "freightcheck-organization-id",
  );
  expect(client.applyBranding).toHaveBeenCalledWith(
    "freightcheck-organization-id",
    product.branding,
    {
      logo: expect.any(Uint8Array),
      icon: expect.any(Uint8Array),
      logoDark: expect.any(Uint8Array),
      iconDark: expect.any(Uint8Array),
    },
    true,
  );
  for (const application of product.applications) {
    expect(client.ensureAdministrator).toHaveBeenCalledWith({
      userId: application.invitation_service_account?.id,
      resource: { organizationId: "freightcheck-organization-id" },
      roles: ["ORG_USER_MANAGER"],
    });
  }
  if (fileName === "products.json") {
    const manifest = JSON.parse(readFileSync("deploy/secrets/manifest.json", "utf8"));
    expect([...secrets.keys()].sort()).toEqual(manifest.generated_product_secrets.sort());
  }
  vi.mocked(client.listOrganizations).mockResolvedValue([
    { id: "ensombl-organization-id", name: "Ensombl" },
    { id: "freightcheck-organization-id", name: "FreightCheck" },
  ]);
  vi.mocked(client.listProjects).mockResolvedValue([
    { projectId: "console-project-id", organizationId: "ensombl-organization-id", name: "ZITADEL" },
    {
      projectId: "freightcheck-project-id",
      organizationId: "freightcheck-organization-id",
      name: "FreightCheck",
    },
  ]);
  vi.mocked(client.listApplications).mockResolvedValue(
    product.applications.map((application) => ({
      projectId: "freightcheck-project-id",
      applicationId: "application-id",
      name: application.name,
      oidcConfiguration: { clientId: "client-id" },
    })),
  );
  vi.mocked(client.listProjectRoles).mockResolvedValue(
    product.roles.map((role) => ({ key: role.key, displayName: role.display_name })),
  );
  vi.mocked(client.getUser).mockImplementation(async (id) => {
    const human = product.local_fixture?.users.find((user) => user.id === id);
    return {
      id,
      username: human?.email ?? "service-account",
      email: human?.email,
      displayName: human?.display_name,
    };
  });
  vi.mocked(client.generateServiceAccountSecret).mockClear();
  vi.mocked(client.createServiceAccount).mockClear();
  const second = await bootstrapCatalog(client, catalog, {
    bws,
    existing: first,
    rotateMissingSecrets: false,
  });
  expect(second).toEqual(first);
  expect(client.generateServiceAccountSecret).not.toHaveBeenCalled();
  expect(client.createServiceAccount).not.toHaveBeenCalled();
  expect(client.createOrganization).toHaveBeenCalledTimes(1);
  expect(client.createProject).toHaveBeenCalledTimes(1);
});
