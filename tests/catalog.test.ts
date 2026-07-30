import { describe, expect, it } from "vitest";
import { catalogSchema, rolesForProduct, secretPrefix } from "../src/catalog.js";

const baseCatalog = {
  issuer: "https://auth.example.com",
  console_path: "/ui/console",
  email: {
    from_address: "noreply@example.com",
    default_from_name: "Example",
  },
  default_roles: [
    { key: "member", display_name: "Member" },
    { key: "admin", display_name: "Administrator" },
    { key: "owner", display_name: "Owner" },
  ],
  products: [
    {
      id: "freightcheck",
      display_name: "FreightCheck",
      auth_origin: "https://auth.freightcheck.io",
      email_from_name: "FreightCheck",
      owner_organization: {
        name: "FreightCheck",
        domain: "identity.freightcheck.io",
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
        },
      ],
    },
  ],
};

describe("product catalog", () => {
  it("inherits the default member, admin, owner role stack", () => {
    const catalog = catalogSchema.parse(baseCatalog);
    const product = catalog.products[0];
    if (!product) throw new Error("Expected one product");
    expect(rolesForProduct(catalog, product)).toEqual(catalog.default_roles);
  });

  it("supports a complete product role override", () => {
    const catalog = catalogSchema.parse({
      ...baseCatalog,
      products: [
        {
          ...baseCatalog.products[0],
          roles: {
            mode: "replace",
            values: [{ key: "reviewer", display_name: "Reviewer" }],
          },
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
});
