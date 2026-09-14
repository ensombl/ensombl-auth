import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("preserves v4.16.2 built-in mappings and adds only directory read access", () => {
  const configuration = JSON.parse(
    readFileSync(new URL("../deploy/zitadel/permissions.json", import.meta.url), "utf8"),
  );
  const roles = configuration.InternalAuthZ.RolePermissionMappings as {
    Role: string;
    Permissions: string[];
  }[];
  const custom = roles.filter((role) => role.Role === "IAM_FREIGHTCHECK_DIRECTORY_READER");
  expect(custom).toEqual([
    { Role: "IAM_FREIGHTCHECK_DIRECTORY_READER", Permissions: ["user.read"] },
  ]);
  const defaults = roles.filter((role) => role.Role !== "IAM_FREIGHTCHECK_DIRECTORY_READER");
  expect(createHash("sha256").update(JSON.stringify(defaults)).digest("hex")).toBe(
    "bf4df9c09827bbcb243f4865d444d5a28f0115fe045e2c3a5a2a35af314aeb11",
  );
  for (const path of ["../docker-compose.yml", "../deploy/dokploy/compose.yml"]) {
    const compose = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(compose).toContain("- --config\n      - /zitadel/permissions.json");
    expect(compose).toContain("/permissions.json:/zitadel/permissions.json:ro");
  }
});
