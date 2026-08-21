import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allocateLocalRuntimePortBlock,
  consumeLocalRuntimePortBlock,
  type LocalRuntimeAllocationDependencies,
  localRuntimeAllocationEnvironment,
  localRuntimePortBlockSize,
  releaseLocalRuntimePortBlock,
} from "../src/local-allocation.js";

const temporaryRoots: string[] = [];

function temporaryRoot(name = "runtime"): string {
  const parent = mkdtempSync(resolve(tmpdir(), "ensombl-auth-allocation-"));
  temporaryRoots.push(parent);
  const path = resolve(parent, name);
  mkdirSync(path);
  return path;
}

function dependencies(
  registryPath: string,
  values: Partial<LocalRuntimeAllocationDependencies> = {},
): LocalRuntimeAllocationDependencies {
  return {
    candidatePortBases: [16_000, 16_016, 16_032, 16_048],
    ephemeralPortRange: [32_768, 60_999],
    listeningPorts: () => new Set(),
    registryPath,
    ...values,
  };
}

function block(portBase: number): readonly number[] {
  return Array.from({ length: localRuntimePortBlockSize }, (_, offset) => portBase + offset);
}

function legacySlot(path: string): number {
  return createHash("sha256").update(resolve(path)).digest().readUInt32BE(0) % 1_800;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("local runtime allocation registry", () => {
  it("resolves current known legacy hash collisions into disjoint complete blocks", () => {
    const fixturePairs = [
      [
        "/home/patrick/orca/workspaces/freightclaims-platform/integrate-pr-698-payment-types",
        "/home/patrick/orca/workspaces/freightclaims-platform/triage-open-pr-752",
      ],
      [
        "/home/patrick/orca/workspaces/freightclaims-platform/triage-open-pr-760",
        "/home/patrick/orca/workspaces/freightclaims-platform/triage-open-pr-763",
      ],
      [
        "/home/patrick/orca/workspaces/freightclaims-platform/fix-pr803-angular-inventory/deps/ensombl-auth",
        "/home/patrick/orca/workspaces/freightclaims-platform/triage-open-pr-757/deps/ensombl-auth",
      ],
      [
        "/home/patrick/orca/workspaces/freightclaims-platform/audit-resume-unlock-exact/deps/ensombl-auth",
        "/home/patrick/orca/workspaces/freightclaims-platform/fix-pr802-angular-inventory/deps/ensombl-auth",
      ],
    ] as const;
    for (const [left, right] of fixturePairs) expect(legacySlot(left)).toBe(legacySlot(right));

    const registryRoot = temporaryRoot("registry-owner");
    const registryPath = resolve(registryRoot, "allocations.json");
    const identity = (path: string) => ({
      device: "fixture",
      inode: createHash("sha256").update(path).digest("hex"),
    });
    for (const [left, right] of fixturePairs) {
      const isolatedRegistryPath = `${registryPath}-${String(legacySlot(left))}`;
      const options = dependencies(isolatedRegistryPath, {
        candidatePortBases: [16_000, 16_016],
        directoryIdentity: identity,
      });
      const allocations = [
        allocateLocalRuntimePortBlock(left, {}, options),
        allocateLocalRuntimePortBlock(right, {}, options),
      ];
      expect(new Set(allocations.flatMap((allocation) => block(allocation.portBase))).size).toBe(
        localRuntimePortBlockSize * 2,
      );
    }
  });

  it("excludes defaults, configured reservations, listeners, and the ephemeral range", () => {
    const root = temporaryRoot();
    const registryPath = resolve(root, "allocations.json");
    const allocation = allocateLocalRuntimePortBlock(
      root,
      { LOCAL_RUNTIME_RESERVED_PORTS: "16000-16015" },
      dependencies(registryPath, {
        candidatePortBases: [2_992, 16_000, 16_016, 16_032, 32_768],
        listeningPorts: () => new Set([16_016]),
      }),
    );

    expect(allocation.portBase).toBe(16_032);
    expect(block(allocation.portBase).every((port) => port < 32_768 || port > 60_999)).toBe(true);
  });

  it("fails clearly when every eligible block is reserved", () => {
    const parent = temporaryRoot("parent");
    const second = resolve(resolve(parent, ".."), "second");
    mkdirSync(second);
    const options = dependencies(resolve(parent, "allocations.json"), {
      candidatePortBases: [16_000],
    });
    allocateLocalRuntimePortBlock(parent, {}, options);

    expect(() => allocateLocalRuntimePortBlock(second, {}, options)).toThrow(
      "No complete local runtime port block is available",
    );
  });

  it("rejects a conflicting registry instead of choosing through it", () => {
    const parent = temporaryRoot("parent");
    const registryPath = resolve(parent, "allocations.json");
    allocateLocalRuntimePortBlock(parent, {}, dependencies(registryPath));
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      reservations: Record<string, unknown>[];
    };
    registry.reservations.push({
      ...registry.reservations[0],
      id: "1111111111111111",
      repositoryRoot: "/foreign",
    });
    writeFileSync(registryPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });

    expect(() => allocateLocalRuntimePortBlock(parent, {}, dependencies(registryPath))).toThrow(
      /conflicting reservations/u,
    );
  });

  it("recovers a stale reservation only after the recorded directory and ports are gone", () => {
    const parent = temporaryRoot("first");
    const container = resolve(parent, "..");
    const registryPath = resolve(container, "allocations.json");
    const options = dependencies(registryPath, { candidatePortBases: [16_000] });
    const first = allocateLocalRuntimePortBlock(parent, {}, options);
    rmSync(parent, { recursive: true });
    const second = resolve(container, "second");
    mkdirSync(second);

    expect(allocateLocalRuntimePortBlock(second, {}, options).portBase).toBe(first.portBase);
  });

  it("rejects stale recovery while a foreign owner still holds the block", () => {
    const parent = temporaryRoot("first");
    const container = resolve(parent, "..");
    const registryPath = resolve(container, "allocations.json");
    const initial = dependencies(registryPath, { candidatePortBases: [16_000] });
    const first = allocateLocalRuntimePortBlock(parent, {}, initial);
    rmSync(parent, { recursive: true });
    const second = resolve(container, "second");
    mkdirSync(second);

    expect(() =>
      allocateLocalRuntimePortBlock(
        second,
        {},
        dependencies(registryPath, {
          candidatePortBases: [16_000],
          listeningPorts: () => new Set([first.portBase]),
        }),
      ),
    ).toThrow(/port block is still active/u);
  });

  it("consumes the exact parent reservation and rejects divergent values", () => {
    const root = temporaryRoot();
    const options = dependencies(resolve(root, "allocations.json"));
    const allocation = allocateLocalRuntimePortBlock(root, {}, options);
    const environment = localRuntimeAllocationEnvironment(allocation);

    expect(consumeLocalRuntimePortBlock(environment, options)).toEqual({
      ...allocation,
      created: false,
    });
    expect(() =>
      consumeLocalRuntimePortBlock(
        { ...environment, LOCAL_RUNTIME_PORT_BASE: String(allocation.portBase + 16) },
        options,
      ),
    ).toThrow(/unavailable or has diverged/u);
  });

  it("recovers a lock from a dead owner and rejects a live foreign lock", () => {
    const first = temporaryRoot("first");
    const container = resolve(first, "..");
    const staleRegistry = resolve(container, "stale.json");
    mkdirSync(`${staleRegistry}.lock`);
    writeFileSync(
      resolve(`${staleRegistry}.lock`, "owner.json"),
      JSON.stringify({ nonce: "stale", pid: process.pid, startTime: "not-current" }),
      { mode: 0o600 },
    );
    expect(
      allocateLocalRuntimePortBlock(first, {}, dependencies(staleRegistry)).repositoryRoot,
    ).toBe(first);

    const second = resolve(container, "second");
    mkdirSync(second);
    const liveRegistry = resolve(container, "live.json");
    const processStat = readFileSync(`/proc/${String(process.pid)}/stat`, "utf8");
    const startTime = processStat
      .slice(processStat.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/u)[19];
    mkdirSync(`${liveRegistry}.lock`);
    writeFileSync(
      resolve(`${liveRegistry}.lock`, "owner.json"),
      JSON.stringify({ nonce: "live", pid: process.pid, startTime }),
      { mode: 0o600 },
    );
    expect(() =>
      allocateLocalRuntimePortBlock(second, {}, dependencies(liveRegistry, { lockTimeoutMs: 0 })),
    ).toThrow(/Timed out waiting for the local runtime registry lock/u);
  });

  it("validates an explicit block override and rejects an active release", () => {
    const root = temporaryRoot();
    const registryPath = resolve(root, "allocations.json");
    const options = dependencies(registryPath);
    const allocation = allocateLocalRuntimePortBlock(
      root,
      { LOCAL_RUNTIME_PORT_BASE: "16032" },
      options,
    );
    expect(allocation.portBase).toBe(16_032);
    expect(() =>
      releaseLocalRuntimePortBlock(
        allocation,
        dependencies(registryPath, { listeningPorts: () => new Set([16_032]) }),
      ),
    ).toThrow(/Refusing to release active/u);
    expect(() =>
      allocateLocalRuntimePortBlock(root, { LOCAL_RUNTIME_PORT_BASE: "32768" }, options),
    ).toThrow(/non-reserved, non-ephemeral/u);
  });

  it("serializes concurrent colliding allocations across processes", async () => {
    const first = temporaryRoot("first");
    const container = resolve(first, "..");
    const preferredCandidate = (path: string) =>
      createHash("sha256").update(resolve(path)).digest().readUInt32BE(4) % 2;
    let suffix = 0;
    let second = resolve(container, `second-${String(suffix)}`);
    while (preferredCandidate(second) !== preferredCandidate(first)) {
      suffix += 1;
      second = resolve(container, `second-${String(suffix)}`);
    }
    mkdirSync(second);
    const registryPath = resolve(container, "allocations.json");
    const moduleUrl = new URL("../src/local-allocation.ts", import.meta.url).href;
    const source = [
      `import { allocateLocalRuntimePortBlock } from ${JSON.stringify(moduleUrl)};`,
      "const allocation = allocateLocalRuntimePortBlock(process.env.TEST_RUNTIME_ROOT, {}, {",
      "candidatePortBases: [16000, 16016],",
      "ephemeralPortRange: [32768, 60999],",
      "listeningPorts: () => new Set(),",
      "registryPath: process.env.TEST_RUNTIME_REGISTRY,",
      "});",
      "process.stdout.write(JSON.stringify(allocation));",
    ].join("\n");
    const run = (runtimeRoot: string) =>
      new Promise<{ readonly portBase: number }>((resolveRun, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", source],
          {
            env: {
              ...process.env,
              TEST_RUNTIME_REGISTRY: registryPath,
              TEST_RUNTIME_ROOT: runtimeRoot,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolveRun(JSON.parse(stdout) as { readonly portBase: number });
          else reject(new Error(stderr || `allocation child exited ${String(code)}`));
        });
      });

    const allocations = await Promise.all([run(first), run(second)]);
    expect(new Set(allocations.map((allocation) => allocation.portBase)).size).toBe(2);
  });
});
