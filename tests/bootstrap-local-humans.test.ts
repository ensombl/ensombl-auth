import { describe, expect, it, vi } from "vitest";
import { provisionLocalHumans } from "../src/bootstrap.js";
import type { Product } from "../src/catalog.js";
import type { ZitadelClient } from "../src/zitadel.js";

const users: NonNullable<Product["local_fixture"]>["users"] = [
  {
    key: "tenant-owner",
    id: "user-owner",
    email: "owner@example.com",
    display_name: "Tenant Owner",
    password: "Local-password-2026!",
    roles: [],
  },
  {
    key: "platform-admin",
    id: "user-platform-admin",
    email: "admin@example.com",
    display_name: "Platform Admin",
    password: "Local-password-2026!",
    roles: ["platform_admin"],
  },
];

describe("local human fixtures", () => {
  it("creates missing users, preserves existing users, and returns no passwords", async () => {
    const client = {
      createHumanUser: vi.fn().mockResolvedValue(undefined),
      ensureAuthorization: vi.fn().mockResolvedValue(undefined),
      getUser: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: "existing" }),
    } as unknown as ZitadelClient;

    const runtime = await provisionLocalHumans(client, users, "project-id", "organization-id");

    expect(client.getUser).toHaveBeenCalledTimes(2);
    expect(client.createHumanUser).toHaveBeenCalledTimes(1);
    expect(client.createHumanUser).toHaveBeenCalledWith({
      organizationId: "organization-id",
      userId: "user-owner",
      email: "owner@example.com",
      displayName: "Tenant Owner",
      password: "Local-password-2026!",
      passwordChangeRequired: false,
    });
    expect(client.ensureAuthorization).toHaveBeenCalledTimes(2);
    expect(client.ensureAuthorization).toHaveBeenNthCalledWith(1, {
      userId: "user-owner",
      projectId: "project-id",
      organizationId: "organization-id",
      roleKeys: [],
    });
    expect(client.ensureAuthorization).toHaveBeenNthCalledWith(2, {
      userId: "user-platform-admin",
      projectId: "project-id",
      organizationId: "organization-id",
      roleKeys: ["platform_admin"],
    });
    expect(runtime).toEqual({
      "tenant-owner": { userId: "user-owner", email: "owner@example.com" },
      "platform-admin": { userId: "user-platform-admin", email: "admin@example.com" },
    });
    expect(JSON.stringify(runtime)).not.toContain("Local-password");
  });
});
