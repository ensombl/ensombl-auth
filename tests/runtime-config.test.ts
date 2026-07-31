import { describe, expect, it, vi } from "vitest";
import { BwsRuntimeStore } from "../src/runtime-config.js";

describe("BwsRuntimeStore", () => {
  it("retries rate-limited writes without exposing the secret in an error", async () => {
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("rate limited"), { stderr: "429 Too Many Requests" }),
      )
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: "secret-id",
          key: "ZITADEL_TEST_CLIENT_SECRET",
          value: "sensitive-value",
        }),
      });
    const wait = vi.fn().mockResolvedValue(undefined);
    const store = new BwsRuntimeStore("project-id", runCommand, wait);

    await store.set("ZITADEL_TEST_CLIENT_SECRET", "sensitive-value");

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_000);
    expect(store.get("ZITADEL_TEST_CLIENT_SECRET")).toBe("sensitive-value");
  });

  it("sanitizes non-rate-limit command failures", async () => {
    const runCommand = vi.fn().mockRejectedValue(
      Object.assign(new Error("command includes sensitive-value"), {
        stderr: "permission denied",
      }),
    );
    const store = new BwsRuntimeStore("project-id", runCommand);

    await expect(store.set("ZITADEL_TEST_CLIENT_SECRET", "sensitive-value")).rejects.toThrow(
      "Bitwarden command failed: secret create",
    );
  });
});
