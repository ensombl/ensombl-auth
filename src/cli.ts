import { readFile } from "node:fs/promises";
import { loadCatalog } from "./catalog.js";
import { reconcileCatalog } from "./reconcile.js";
import { BwsRuntimeStore, readRuntimeConfig, writeRuntimeConfig } from "./runtime-config.js";
import { ZitadelClient } from "./zitadel.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readPat(): Promise<string> {
  const inline = process.env.ZITADEL_ADMIN_PAT?.trim();
  if (inline) return inline;
  return (await readFile(required("ZITADEL_ADMIN_PAT_FILE"), "utf8")).trim();
}

async function main(): Promise<void> {
  const catalogPath = process.env.PRODUCT_CATALOG_PATH ?? "deploy/products/products.json";
  const outputPath = process.env.ZITADEL_RUNTIME_CONFIG_PATH ?? ".local/runtime.json";
  const catalog = await loadCatalog(catalogPath);
  const requestHost = process.env.ZITADEL_REQUEST_HOST?.trim();
  const adminPat = await readPat();
  const client = new ZitadelClient(required("ZITADEL_URL"), adminPat, {
    ...(requestHost ? { "x-forwarded-host": requestHost } : {}),
    ...(process.env.ZITADEL_FORWARDED_PROTO
      ? { "x-forwarded-proto": process.env.ZITADEL_FORWARDED_PROTO }
      : {}),
  });
  await client.waitUntilReady();

  const bwsProjectId = process.env.BWS_PROJECT_ID?.trim();
  const bws = bwsProjectId ? new BwsRuntimeStore(bwsProjectId) : undefined;
  await bws?.initialize();

  const existing = await readRuntimeConfig(outputPath);
  const runtime = await reconcileCatalog(client, catalog, {
    ...(existing ? { existing } : {}),
    ...(bws ? { bws } : {}),
    rotateMissingSecrets: process.env.ZITADEL_ROTATE_MISSING_CLIENT_SECRETS === "true",
  });
  if (process.env.ZITADEL_RUNTIME_INCLUDE_ADMIN_PAT === "true") {
    runtime.managementToken = adminPat;
  }
  await writeRuntimeConfig(outputPath, runtime);

  console.log(
    `Reconciled ${Object.keys(runtime.products).length} product(s); runtime config: ${outputPath}`,
  );
}

await main();
