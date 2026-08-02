import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const roleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  display_name: z.string().min(1).max(200),
});

const brandingSchema = z.object({
  primary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  warn_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  background_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  font_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  primary_color_dark: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  warn_color_dark: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  background_color_dark: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  font_color_dark: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  theme_mode: z
    .enum(["THEME_MODE_AUTO", "THEME_MODE_DARK", "THEME_MODE_LIGHT"])
    .default("THEME_MODE_AUTO"),
  hide_login_name_suffix: z.boolean().default(false),
  logo_base64_file: z.string().min(1).optional(),
});

const loginPolicySchema = z.object({
  allow_username_password: z.boolean().default(true),
  allow_self_registration: z.boolean().default(false),
  allow_external_identity_providers: z.boolean().default(false),
  allow_password_reset: z.boolean().default(true),
  ignore_unknown_usernames: z.boolean().default(true),
  allow_domain_discovery: z.boolean().default(false),
  disable_login_with_email: z.boolean().default(false),
  disable_login_with_phone: z.boolean().default(true),
});

const defaultLoginPolicy = {
  allow_username_password: true,
  allow_self_registration: false,
  allow_external_identity_providers: false,
  allow_password_reset: true,
  ignore_unknown_usernames: true,
  allow_domain_discovery: false,
  disable_login_with_email: false,
  disable_login_with_phone: true,
} as const;

const applicationSchema = z.object({
  environment: z.enum(["local", "staging", "production"]),
  name: z.string().min(1).max(200),
  base_url: z.url(),
  development_mode: z.boolean().default(false),
  management_service_account: z.object({
    id: z.uuid(),
    username: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/),
    display_name: z.string().min(1).max(200),
  }),
});

const migrationServiceAccountSchema = z.object({
  id: z.uuid(),
  username: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/),
  display_name: z.string().min(1).max(200),
  verify_imported_passwords: z.boolean().default(false),
});

const serviceAccountSchema = z.object({
  id: z.string().min(1).max(200),
  username: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/),
  display_name: z.string().min(1).max(200),
  roles: z.array(roleSchema.shape.key).default([]),
});

const productSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  display_name: z.string().min(1).max(200),
  auth_origin: z.url(),
  email_from_name: z.string().min(1).max(200),
  owner_organization: z.object({
    name: z.string().min(1).max(200),
    domain: z.string().min(1).max(253),
  }),
  branding: brandingSchema,
  login_policy: loginPolicySchema.default(defaultLoginPolicy),
  roles: z.array(roleSchema).default([]),
  migration_service_account: migrationServiceAccountSchema.optional(),
  applications: z.array(applicationSchema).min(1),
  local_fixture: z
    .object({
      tenant: z.object({
        id: z.string().min(1).max(200),
        name: z.string().min(1).max(200),
      }),
      user: z.object({
        id: z.string().min(1).max(200),
        email: z.email(),
        display_name: z.string().min(1).max(200),
        password: z.string().min(12).max(200),
        roles: z.array(roleSchema.shape.key).default([]),
      }),
      service_accounts: z.array(serviceAccountSchema).default([]),
    })
    .optional(),
});

export const catalogSchema = z
  .object({
    issuer: z.url(),
    console_path: z.string().startsWith("/"),
    instance_organization: z.object({
      name: z.string().min(1).max(200),
      domain: z.string().min(1).max(253),
    }),
    email: z.object({
      from_address: z.email(),
      default_from_name: z.string().min(1).max(200),
    }),
    products: z.array(productSchema).min(1),
  })
  .superRefine((catalog, context) => {
    const productIds = new Set<string>();
    for (const [productIndex, product] of catalog.products.entries()) {
      if (productIds.has(product.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate product id: ${product.id}`,
          path: ["products", productIndex, "id"],
        });
      }
      productIds.add(product.id);

      const roles = new Set(product.roles.map((role) => role.key));
      for (const role of product.local_fixture?.user.roles ?? []) {
        if (!roles.has(role)) {
          context.addIssue({
            code: "custom",
            message: `Unknown local user role: ${role}`,
            path: ["products", productIndex, "local_fixture", "user", "roles"],
          });
        }
      }
      const serviceAccountIds = new Set<string>();
      const serviceAccountUsernames = new Set<string>();
      for (const [accountIndex, account] of (
        product.local_fixture?.service_accounts ?? []
      ).entries()) {
        for (const role of account.roles) {
          if (!roles.has(role)) {
            context.addIssue({
              code: "custom",
              message: `Unknown local service-account role: ${role}`,
              path: [
                "products",
                productIndex,
                "local_fixture",
                "service_accounts",
                accountIndex,
                "roles",
              ],
            });
          }
        }
        for (const [values, value, field] of [
          [serviceAccountIds, account.id, "id"],
          [serviceAccountUsernames, account.username, "username"],
        ] as const) {
          if (values.has(value)) {
            context.addIssue({
              code: "custom",
              message: `Duplicate local service-account ${field}: ${value}`,
              path: [
                "products",
                productIndex,
                "local_fixture",
                "service_accounts",
                accountIndex,
                field,
              ],
            });
          }
          values.add(value);
        }
      }

      const environments = new Set<string>();
      const managementAccountIds = new Set<string>();
      const managementAccountUsernames = new Set<string>();
      for (const [applicationIndex, application] of product.applications.entries()) {
        if (environments.has(application.environment)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate ${product.id} environment: ${application.environment}`,
            path: ["products", productIndex, "applications", applicationIndex, "environment"],
          });
        }
        environments.add(application.environment);
        for (const [values, value, field] of [
          [managementAccountIds, application.management_service_account.id, "id"],
          [managementAccountUsernames, application.management_service_account.username, "username"],
        ] as const) {
          if (values.has(value)) {
            context.addIssue({
              code: "custom",
              message: `Duplicate management service-account ${field}: ${value}`,
              path: [
                "products",
                productIndex,
                "applications",
                applicationIndex,
                "management_service_account",
                field,
              ],
            });
          }
          values.add(value);
        }
      }
      const migrationAccount = product.migration_service_account;
      if (migrationAccount) {
        for (const [values, value, field] of [
          [managementAccountIds, migrationAccount.id, "id"],
          [managementAccountUsernames, migrationAccount.username, "username"],
        ] as const) {
          if (values.has(value)) {
            context.addIssue({
              code: "custom",
              message: `Duplicate product service-account ${field}: ${value}`,
              path: ["products", productIndex, "migration_service_account", field],
            });
          }
          values.add(value);
        }
      }
    }
  });

export type Catalog = z.infer<typeof catalogSchema>;
export type Product = Catalog["products"][number];
export type ProductApplication = Product["applications"][number];
export type Role = Product["roles"][number];

export async function loadCatalog(path: string): Promise<Catalog> {
  const catalog = catalogSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const catalogDirectory = dirname(resolve(path));
  return {
    ...catalog,
    products: catalog.products.map((product) => ({
      ...product,
      branding: {
        ...product.branding,
        ...(product.branding.logo_base64_file
          ? {
              logo_base64_file: resolve(catalogDirectory, product.branding.logo_base64_file),
            }
          : {}),
      },
    })),
  };
}

export function rolesForProduct(catalog: Catalog, product: Product): Role[] {
  void catalog;
  return product.roles;
}

export function secretPrefix(product: Product, application: ProductApplication): string {
  return `ZITADEL_${product.id}_${application.environment}`.replaceAll("-", "_").toUpperCase();
}

export function migrationSecretPrefix(product: Product): string {
  return `ZITADEL_${product.id}_MIGRATION`.replaceAll("-", "_").toUpperCase();
}
