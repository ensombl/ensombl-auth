import { describe, expect, it, vi } from "vitest";
import { provisionLocalHumans } from "../src/bootstrap.js";
import type { Product } from "../src/catalog.js";
import type { ZitadelClient } from "../src/zitadel.js";

const passwordChangeUser: NonNullable<Product["local_fixture"]>["users"][number] = {
  key: "platform-admin",
  id: "user-platform-admin",
  email: "admin@example.com",
  display_name: "Platform Admin",
  password: "Local-password-2026!",
  password_change_required: true,
  roles: ["platform_admin"],
};

const users: NonNullable<Product["local_fixture"]>["users"] = [
  {
    key: "tenant-owner",
    id: "user-owner",
    email: "owner@example.com",
    display_name: "Tenant Owner",
    password: "Local-password-2026!",
    password_change_required: false,
    roles: [],
  },
  passwordChangeUser,
];

describe("local human fixtures", () => {
  it("creates missing users, preserves matching users, and returns no passwords", async () => {
    const client = {
      createHumanUser: vi.fn().mockResolvedValue(undefined),
      updateHumanUser: vi.fn().mockResolvedValue(undefined),
      ensureAuthorization: vi.fn().mockResolvedValue(undefined),
      getUser: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({
        id: "user-platform-admin",
        username: "admin@example.com",
        email: "admin@example.com",
        displayName: "Platform Admin",
      }),
    } as unknown as ZitadelClient;

    const runtime = await provisionLocalHumans(client, users, "project-id", "organization-id");

    expect(client.getUser).toHaveBeenCalledTimes(2);
    expect(client.createHumanUser).toHaveBeenCalledTimes(1);
    expect(client.updateHumanUser).not.toHaveBeenCalled();
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
    expect(client.createHumanUser).toHaveBeenCalledWith(
      expect.objectContaining({ passwordChangeRequired: false }),
    );
    expect(runtime).toEqual({
      "tenant-owner": { userId: "user-owner", email: "owner@example.com" },
      "platform-admin": { userId: "user-platform-admin", email: "admin@example.com" },
    });
    expect(JSON.stringify(runtime)).not.toContain("Local-password");
  });

  it("passes a local user's forced-password-change setting when creating it", async () => {
    const client = {
      createHumanUser: vi.fn().mockResolvedValue(undefined),
      updateHumanUser: vi.fn().mockResolvedValue(undefined),
      ensureAuthorization: vi.fn().mockResolvedValue(undefined),
      getUser: vi.fn().mockResolvedValue(undefined),
    } as unknown as ZitadelClient;

    await provisionLocalHumans(client, [passwordChangeUser], "project-id", "organization-id");

    expect(client.createHumanUser).toHaveBeenCalledWith(
      expect.objectContaining({ passwordChangeRequired: true }),
    );
  });

  it("converges an existing fixture user's login, email, and profile", async () => {
    const client = {
      createHumanUser: vi.fn().mockResolvedValue(undefined),
      updateHumanUser: vi.fn().mockResolvedValue(undefined),
      ensureAuthorization: vi.fn().mockResolvedValue(undefined),
      getUser: vi
        .fn()
        .mockResolvedValueOnce({
          id: "user-owner",
          username: "owner@example.com",
          email: "owner@example.com",
          displayName: "Old display name",
        })
        .mockResolvedValueOnce({
          id: "user-platform-admin",
          username: "old-admin@example.com",
          email: "old-admin@example.com",
          displayName: "Platform Admin",
        }),
    } as unknown as ZitadelClient;

    await provisionLocalHumans(client, users, "project-id", "organization-id");

    expect(client.createHumanUser).not.toHaveBeenCalled();
    expect(client.updateHumanUser).toHaveBeenCalledTimes(2);
    expect(client.updateHumanUser).toHaveBeenNthCalledWith(1, {
      userId: "user-owner",
      email: "owner@example.com",
      displayName: "Tenant Owner",
    });
    expect(client.updateHumanUser).toHaveBeenNthCalledWith(2, {
      userId: "user-platform-admin",
      email: "admin@example.com",
      displayName: "Platform Admin",
    });
  });
});
