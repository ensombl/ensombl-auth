import { afterEach, expect, it, vi } from "vitest";
import { loadCatalog } from "../src/catalog.js";
import { ZitadelClient } from "../src/zitadel.js";

afterEach(() => vi.restoreAllMocks());

it("uses FreightCheck issuer, mail identity, assets, and hosted return destination", async () => {
  const catalog = await loadCatalog("deploy/products/products.json");
  const product = catalog.products.find((entry) => entry.id === "freightcheck");
  expect(catalog.issuer).toBe("https://auth.freightcheck.io");
  expect(catalog.email.from_address).toBe("noreply@notifications.freightcheck.io");
  expect(product?.branding.logo_base64_file).toContain("freightcheck-logo");
  expect(product?.branding.icon_base64_file).toContain("freightcheck-logo");
  expect(product?.login_policy.default_redirect_uri).toBe(
    "https://app.staging.freightcheck.io/auth/login?returnTo=%2Finvitations",
  );
  expect(product?.applications.every((application) => application.invitation_service_account)).toBe(
    true,
  );
});

it("activates instance branding and uploads the icon through instance endpoints", async () => {
  const catalog = await loadCatalog("deploy/products/products.json");
  const product = catalog.products.find((entry) => entry.id === "freightcheck");
  if (!product) throw new Error("Missing FreightCheck");
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
  const client = new ZitadelClient("https://auth.freightcheck.io", "token");
  await client.applyBranding(
    "freightcheck",
    product.branding,
    undefined,
    true,
    new Uint8Array([1, 2, 3]),
  );
  const urls = fetcher.mock.calls.map(([url]) => String(url));
  expect(urls).toContain("https://auth.freightcheck.io/admin/v1/policies/label/_activate");
  expect(urls).toContain("https://auth.freightcheck.io/assets/v1/policy/label/icon");
  expect(urls.some((url) => url.includes("/management/"))).toBe(false);
});
