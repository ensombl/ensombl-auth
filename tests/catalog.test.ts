import { describe, expect, it } from "vitest";
import { catalogSchema, rolesForProduct, secretPrefix } from "../src/catalog.js";

const baseCatalog = {
  issuer: "https://auth.example.com",
  console_path: "/ui/console",
  instance_organization: {
    name: "Example",
    domain: "example.com",
  },
  email: {
    from_address: "noreply@example.com",
    default_from_name: "Example",
  },
  products: [
    {
      id: "freightcheck",
      display_name: "FreightCheck",
      auth_origin: "https://auth.freightcheck.io",
      email_from_name: "FreightCheck",
      owner_organization: {
        name: "FreightCheck",
        domain: "freightcheck.io",
      },
      branding: {
        primary_color: "#123456",
        warn_color: "#123456",
        background_color: "#123456",
        font_color: "#123456",
        primary_color_dark: "#123456",
        warn_color_dark: "#123456",
        background_color_dark: "#123456",
        font_color_dark: "#123456",
      },
      applications: [
        {
          environment: "production",
          name: "FreightCheck production web",
          base_url: "https://app.freightcheck.io",
          management_service_account: {
            id: "01900000-0000-7000-8000-000000000100",
            username: "freightcheck-production-management",
            display_name: "FreightCheck production management",
          },
        },
      ],
    },
  ],
};

describe("product catalog", () => {
  it("defaults products to no project roles", () => {
    const catalog = catalogSchema.parse(baseCatalog);
    const product = catalog.products[0];
    if (!product) throw new Error("Expected one product");
    expect(rolesForProduct(catalog, product)).toEqual([]);
  });

  it("supports explicitly declared product-wide roles", () => {
    const catalog = catalogSchema.parse({
      ...baseCatalog,
      products: [
        {
          ...baseCatalog.products[0],
          roles: [{ key: "reviewer", display_name: "Reviewer" }],
        },
      ],
    });
    const product = catalog.products[0];
    if (!product) throw new Error("Expected one product");
    expect(rolesForProduct(catalog, product)).toEqual([
      { key: "reviewer", display_name: "Reviewer" },
    ]);
  });

  it("uses canonical staging and production secret names", () => {
    const catalog = catalogSchema.parse(baseCatalog);
    const product = catalog.products[0];
    const application = product?.applications[0];
    if (!product || !application) throw new Error("Expected one product application");
    expect(secretPrefix(product, application)).toBe("ZITADEL_FREIGHTCHECK_PRODUCTION");
  });

  it("allows a dedicated local migration account to request bounded password verification", () => {
    const catalog = catalogSchema.parse({
      ...baseCatalog,
      products: [
        {
          ...baseCatalog.products[0],
          migration_service_account: {
            id: "01900000-0000-7000-8000-000000000200",
            username: "freightcheck-local-migration",
            display_name: "FreightCheck local migration",
            verify_imported_passwords: true,
          },
        },
      ],
    });
    expect(catalog.products[0]?.migration_service_account?.verify_imported_passwords).toBe(true);
  });

  it("rejects a migration account that reuses an application management identity", () => {
    const management = baseCatalog.products[0]?.applications[0]?.management_service_account;
    if (!management) throw new Error("Expected one product application");
    expect(() =>
      catalogSchema.parse({
        ...baseCatalog,
        products: [
          {
            ...baseCatalog.products[0],
            migration_service_account: management,
          },
        ],
      }),
    ).toThrow(/Duplicate product service-account/u);
  });

  it("rejects duplicate management service accounts within a product", () => {
    const application = baseCatalog.products[0]?.applications[0];
    if (!application) throw new Error("Expected one product application");
    expect(() =>
      catalogSchema.parse({
        ...baseCatalog,
        products: [
          {
            ...baseCatalog.products[0],
            applications: [
              { ...application, environment: "staging" },
              { ...application, environment: "production" },
            ],
          },
        ],
      }),
    ).toThrow(/Duplicate management service-account/u);
  });

  it("requires local fixture assignments to use declared product-wide roles", () => {
    expect(() =>
      catalogSchema.parse({
        ...baseCatalog,
        products: [
          {
            ...baseCatalog.products[0],
            local_fixture: {
              tenant: {
                id: "tenant",
                name: "Local tenant",
              },
              user: {
                id: "user",
                email: "developer@example.com",
                display_name: "Local developer",
                password: "Local-password-2026!",
                roles: [],
              },
              service_accounts: [
                {
                  id: "machine",
                  username: "local-machine",
                  display_name: "Local machine",
                  roles: ["undeclared_role"],
                },
              ],
            },
          },
        ],
      }),
    ).toThrow(/Unknown local service-account role/u);
  });
});
