import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { loadCatalog } from "../src/catalog.js";

const mocks = vi.hoisted(() => ({
  ensureSmtpEmailProvider: vi.fn(),
  get: vi.fn(),
  initialize: vi.fn(),
  waitUntilReady: vi.fn(),
  bootstrapCatalog: vi.fn().mockResolvedValue({ products: { freightcheck: {} } }),
  readRuntimeConfig: vi.fn(),
  writeRuntimeConfig: vi.fn(),
}));

vi.mock("../src/zitadel.js", () => ({
  ZitadelClient: class {
    ensureSmtpEmailProvider = mocks.ensureSmtpEmailProvider;
    waitUntilReady = mocks.waitUntilReady;
  },
}));
vi.mock("../src/runtime-config.js", () => ({
  BwsRuntimeStore: class {
    get = mocks.get;
    initialize = mocks.initialize;
  },
  readRuntimeConfig: mocks.readRuntimeConfig,
  writeRuntimeConfig: mocks.writeRuntimeConfig,
}));
vi.mock("../src/bootstrap.js", () => ({ bootstrapCatalog: mocks.bootstrapCatalog }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("reconciles SMTP from the catalog using the existing auth Resend key", async () => {
  vi.stubEnv("PRODUCT_CATALOG_PATH", "deploy/products/products.json");
  vi.stubEnv("ZITADEL_ADMIN_PAT", "test-admin-pat");
  vi.stubEnv("ZITADEL_URL", "https://auth.freightcheck.io");
  vi.stubEnv("BWS_PROJECT_ID", "test-project");
  vi.stubEnv("LOCAL_AUTH_ISSUER", "");
  vi.stubEnv("LOCAL_APPLICATION_BASE_URL", "");
  mocks.get.mockReturnValue("existing-auth-resend-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  await import("../src/cli.js");
  expect(mocks.get).toHaveBeenCalledExactlyOnceWith("RESEND_API_KEY");
  expect(mocks.ensureSmtpEmailProvider).toHaveBeenCalledExactlyOnceWith({
    host: "smtp.resend.com:587",
    user: "resend",
    password: "existing-auth-resend-key",
    senderAddress: "noreply@notifications.ensombl.io",
    senderName: "FreightCheck",
    replyToAddress: "noreply@notifications.ensombl.io",
    description: "FreightCheck system notifications via Resend",
    tls: true,
  });
});

it("keeps initial SMTP and both catalogs aligned with reconciliation", async () => {
  const loader = readFileSync("deploy/secret-loader/load.sh", "utf8");
  const compose = readFileSync("docker-compose.yml", "utf8");
  for (const name of ["products.json", "products.local.json"]) {
    const catalog = await loadCatalog(`deploy/products/${name}`);
    expect(loader).toContain(`From: "${catalog.email.from_address}"`);
    expect(loader).toContain(`ReplyToAddress: "${catalog.email.from_address}"`);
    expect(loader).toContain(`FromName: "${catalog.email.default_from_name}"`);
    expect(compose).toContain(
      `ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_FROM: ${catalog.email.from_address}`,
    );
    expect(compose).toContain(
      `ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_FROMNAME: ${catalog.email.default_from_name}`,
    );
  }
  expect(loader).toContain('resend_api_key="$(secret RESEND_API_KEY)"');
});
