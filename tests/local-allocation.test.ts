import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
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
  mkdirSync(path, { mode: 0o700 });
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

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for test path: ${path}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function writeLockOwner(
  lockPath: string,
  owner: {
    readonly nonce: string;
    readonly pid: number;
    readonly processInstanceId?: string;
  },
): void {
  const identity = statSync(lockPath, { bigint: true });
  const completeOwner = {
    ...owner,
    device: String(identity.dev),
    inode: String(identity.ino),
  };
  writeFileSync(
    resolve(
      lockPath,
      `owner.${completeOwner.device}.${completeOwner.inode}.${completeOwner.nonce}.json`,
    ),
    JSON.stringify(completeOwner),
    { mode: 0o600 },
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("local runtime allocation registry", () => {
  it.runIf(process.platform !== "win32")("never changes shared registry parent permissions", () => {
    const root = temporaryRoot();
    const sharedParent = resolve(root, "shared");
    mkdirSync(sharedParent, { mode: 0o755 });
    chmodSync(sharedParent, 0o755);
    const sharedRegistry = resolve(sharedParent, "allocations.json");
    const environment = { FREIGHTCLAIMS_LOCAL_RUNTIME_REGISTRY_PATH: sharedRegistry };
    const options: LocalRuntimeAllocationDependencies = {
      candidatePortBases: [16_000, 16_016, 16_032, 16_048],
      ephemeralPortRange: [32_768, 60_999],
      listeningPorts: () => new Set(),
    };
    const before = statSync(sharedParent).mode & 0o777;

    expect(() => allocateLocalRuntimePortBlock(root, environment, options)).toThrow(
      /directory permissions are not private/u,
    );
    expect(statSync(sharedParent).mode & 0o777).toBe(before);
    expect(existsSync(sharedRegistry)).toBe(false);

    const privateRegistry = resolve(sharedParent, "freightclaims", "allocations.json");
    const allocation = allocateLocalRuntimePortBlock(
      root,
      { FREIGHTCLAIMS_LOCAL_RUNTIME_REGISTRY_PATH: privateRegistry },
      options,
    );
    expect(allocation.registryPath).toBe(privateRegistry);
    expect(statSync(sharedParent).mode & 0o777).toBe(before);
    expect(statSync(resolve(sharedParent, "freightclaims")).mode & 0o777).toBe(0o700);

    chmodSync(privateRegistry, 0o644);
    expect(() =>
      allocateLocalRuntimePortBlock(
        root,
        { FREIGHTCLAIMS_LOCAL_RUNTIME_REGISTRY_PATH: privateRegistry },
        options,
      ),
    ).toThrow(/registry permissions are not private/u);
  });

  it.runIf(process.platform === "win32")(
    "uses native Windows filesystem semantics for the registry",
    () => {
      const root = temporaryRoot();
      const registryPath = resolve(root, "state", "allocations.json");
      const options = dependencies(registryPath, {
        processInstanceId: (pid) => `windows-${String(pid)}`,
      });

      const allocation = allocateLocalRuntimePortBlock(root, {}, options);
      expect(allocateLocalRuntimePortBlock(root, {}, options)).toEqual({
        ...allocation,
        created: false,
      });
      expect(statSync(resolve(registryPath, "..")).isDirectory()).toBe(true);
      expect(statSync(registryPath).isFile()).toBe(true);
    },
  );

  it("uses portable allocation probes without an executable PATH", () => {
    const root = temporaryRoot();
    const registryPath = resolve(root, "portable", "allocations.json");
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const allocation = allocateLocalRuntimePortBlock(
        root,
        {},
        {
          candidatePortBases: [16_000],
          ephemeralPortRange: [32_768, 60_999],
          registryPath,
        },
      );
      expect(allocation.portBase).toBeLessThan(32_768);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("excludes a live host ephemeral range configured below 32768", () => {
    const root = temporaryRoot();
    const registryPath = resolve(root, "allocations.json");
    const allocation = allocateLocalRuntimePortBlock(
      root,
      {},
      {
        candidatePortBases: [16_000, 16_016, 16_032],
        hostEphemeralPortRange: () => [16_000, 16_031],
        listeningPorts: () => new Set(),
        registryPath,
      },
    );

    expect(allocation.portBase).toBe(16_032);
  });

  it("accepts a reviewed host ephemeral range from the production environment", () => {
    const root = temporaryRoot();
    const registryPath = resolve(root, "allocations.json");
    const allocation = allocateLocalRuntimePortBlock(
      root,
      { LOCAL_RUNTIME_EPHEMERAL_PORT_RANGE: "16000-16031" },
      {
        candidatePortBases: [16_000, 16_016, 16_032],
        hostEphemeralPortRange: () => {
          throw new Error("host discovery must not run");
        },
        listeningPorts: () => new Set(),
        registryPath,
      },
    );

    expect(allocation.portBase).toBe(16_032);
  });

  it("fails closed when the host ephemeral range is unsupported or unreadable", () => {
    const unsupportedRoot = temporaryRoot("unsupported");
    const unsupportedRegistry = resolve(unsupportedRoot, "allocations.json");
    expect(() =>
      allocateLocalRuntimePortBlock(
        unsupportedRoot,
        {},
        {
          candidatePortBases: [16_000],
          hostEphemeralPortRange: () => undefined,
          listeningPorts: () => new Set(),
          registryPath: unsupportedRegistry,
        },
      ),
    ).toThrow(/LOCAL_RUNTIME_EPHEMERAL_PORT_RANGE/u);
    expect(existsSync(unsupportedRegistry)).toBe(false);

    const unreadableRoot = temporaryRoot("unreadable");
    const unreadableRegistry = resolve(unreadableRoot, "allocations.json");
    expect(() =>
      allocateLocalRuntimePortBlock(
        unreadableRoot,
        {},
        {
          candidatePortBases: [16_000],
          hostEphemeralPortRange: () => {
            throw new Error("host policy unavailable");
          },
          listeningPorts: () => new Set(),
          registryPath: unreadableRegistry,
        },
      ),
    ).toThrow(/Could not determine the live host ephemeral port range/u);
    expect(existsSync(unreadableRegistry)).toBe(false);
  });

  it("rejects an invalid configured host ephemeral range", () => {
    const root = temporaryRoot();
    const registryPath = resolve(root, "allocations.json");

    expect(() =>
      allocateLocalRuntimePortBlock(
        root,
        { LOCAL_RUNTIME_EPHEMERAL_PORT_RANGE: "16031-16000" },
        {
          candidatePortBases: [16_032],
          listeningPorts: () => new Set(),
          registryPath,
        },
      ),
    ).toThrow(/LOCAL_RUNTIME_EPHEMERAL_PORT_RANGE is invalid/u);
    expect(existsSync(registryPath)).toBe(false);
  });

  it("detects an occupied block with the portable Node TCP probe before writing", async () => {
    const root = temporaryRoot();
    const registryPath = resolve(root, "portable", "allocations.json");
    const server = createServer();
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const portBase = address.port - (address.port % localRuntimePortBlockSize);
      expect(() =>
        allocateLocalRuntimePortBlock(
          root,
          {},
          {
            candidatePortBases: [portBase],
            ephemeralPortRange: [1_024, 1_024],
            registryPath,
          },
        ),
      ).toThrow("No complete local runtime port block is available");
      expect(existsSync(registryPath)).toBe(false);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

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

  it("rejects an unaligned registry base before allocating an overlapping block", () => {
    const root = temporaryRoot();
    const registryPath = resolve(root, "allocations.json");
    allocateLocalRuntimePortBlock(root, {}, dependencies(registryPath));
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      reservations: { portBase: number }[];
    };
    const [reservation] = registry.reservations;
    if (!reservation) throw new Error("Expected a registry reservation");
    reservation.portBase = 16_001;
    writeFileSync(registryPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });

    expect(() => allocateLocalRuntimePortBlock(root, {}, dependencies(registryPath))).toThrow(
      /Invalid local runtime reservation/u,
    );
  });

  it("rejects a computed allocation ID already owned by another root before writing", () => {
    const foreignRoot = temporaryRoot("foreign");
    const container = resolve(foreignRoot, "..");
    const requestedRoot = resolve(container, "requested");
    mkdirSync(requestedRoot);
    const registryPath = resolve(container, "allocations.json");
    const foreignIdentity = statSync(foreignRoot, { bigint: true });
    const collisionId = createHash("sha256").update(requestedRoot).digest("hex").slice(0, 16);
    writeFileSync(
      registryPath,
      `${JSON.stringify({
        reservations: [
          {
            device: String(foreignIdentity.dev),
            id: collisionId,
            inode: String(foreignIdentity.ino),
            portBase: 16_000,
            repositoryRoot: foreignRoot,
          },
        ],
        version: 1,
      })}\n`,
      { mode: 0o600 },
    );
    const originalRegistry = readFileSync(registryPath, "utf8");

    expect(() =>
      allocateLocalRuntimePortBlock(
        requestedRoot,
        {},
        dependencies(registryPath, { candidatePortBases: [16_016] }),
      ),
    ).toThrow(`Local runtime allocation ID ${collisionId} is already owned by ${foreignRoot}`);
    expect(readFileSync(registryPath, "utf8")).toBe(originalRegistry);
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

  it.each([
    "missing",
    "replaced",
  ] as const)("retains an active reservation for a %s worktree and allocates a free block", (state) => {
    const parent = temporaryRoot("first");
    const container = resolve(parent, "..");
    const registryPath = resolve(container, "allocations.json");
    const initial = dependencies(registryPath, { candidatePortBases: [16_000, 16_016] });
    const first = allocateLocalRuntimePortBlock(parent, {}, initial);
    if (state === "missing") {
      rmSync(parent, { recursive: true });
    } else {
      renameSync(parent, resolve(container, "original-first"));
      mkdirSync(parent);
    }
    const second = resolve(container, "second");
    mkdirSync(second);

    const next = allocateLocalRuntimePortBlock(
      second,
      {},
      dependencies(registryPath, {
        candidatePortBases: [16_000, 16_016],
        listeningPorts: () => new Set([first.portBase]),
      }),
    );
    expect(next.portBase).not.toBe(first.portBase);
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      reservations: { id: string; portBase: number }[];
    };
    expect(registry.reservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, portBase: first.portBase }),
        expect.objectContaining({ id: next.id, portBase: next.portBase }),
      ]),
    );
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

  it("recovers a dead or PID-reused lock and rejects a live or ambiguous owner", () => {
    const first = temporaryRoot("first");
    const container = resolve(first, "..");
    const staleRegistry = resolve(container, "stale.json");
    const staleNonce = "00000000-0000-4000-8000-000000000001";
    mkdirSync(`${staleRegistry}.lock`);
    writeLockOwner(`${staleRegistry}.lock`, {
      nonce: staleNonce,
      pid: 2_147_483_647,
      processInstanceId: "1".repeat(64),
    });
    expect(
      allocateLocalRuntimePortBlock(
        first,
        {},
        dependencies(staleRegistry, {
          processInstanceId: (pid) => (pid === process.pid ? "2".repeat(64) : undefined),
          processIsAlive: (pid) => pid === process.pid,
        }),
      ).repositoryRoot,
    ).toBe(first);

    const legacyRoot = resolve(container, "legacy");
    mkdirSync(legacyRoot);
    const legacyRegistry = resolve(container, "legacy.json");
    mkdirSync(`${legacyRegistry}.lock`);
    writeLockOwner(`${legacyRegistry}.lock`, {
      nonce: "00000000-0000-4000-8000-000000000006",
      pid: 2_147_483_646,
    });
    const [legacyOwnerFile] = readdirSync(`${legacyRegistry}.lock`);
    if (!legacyOwnerFile) throw new Error("Expected the legacy lock owner file");
    expect(
      JSON.parse(readFileSync(resolve(`${legacyRegistry}.lock`, legacyOwnerFile), "utf8")),
    ).not.toHaveProperty("processInstanceId");
    expect(
      allocateLocalRuntimePortBlock(
        legacyRoot,
        {},
        dependencies(legacyRegistry, {
          lockTimeoutMs: 0,
          processInstanceId: (pid) => {
            if (pid !== process.pid) throw new Error("Dead process instance inspected");
            return "2".repeat(64);
          },
          processIsAlive: (pid) => pid === process.pid,
        }),
      ).repositoryRoot,
    ).toBe(legacyRoot);

    const second = resolve(container, "second");
    mkdirSync(second);
    const reusedRegistry = resolve(container, "reused.json");
    const reusedNonce = "00000000-0000-4000-8000-000000000004";
    mkdirSync(`${reusedRegistry}.lock`);
    writeLockOwner(`${reusedRegistry}.lock`, {
      nonce: reusedNonce,
      pid: 123_456,
      processInstanceId: "3".repeat(64),
    });
    expect(
      allocateLocalRuntimePortBlock(
        second,
        {},
        dependencies(reusedRegistry, {
          processInstanceId: (pid) => (pid === process.pid ? "2".repeat(64) : "4".repeat(64)),
          processIsAlive: () => true,
        }),
      ).repositoryRoot,
    ).toBe(second);

    const third = resolve(container, "third");
    mkdirSync(third);
    const liveRegistry = resolve(container, "live.json");
    const liveNonce = "00000000-0000-4000-8000-000000000002";
    mkdirSync(`${liveRegistry}.lock`);
    writeLockOwner(`${liveRegistry}.lock`, {
      nonce: liveNonce,
      pid: process.pid,
      processInstanceId: "2".repeat(64),
    });
    expect(() =>
      allocateLocalRuntimePortBlock(
        third,
        {},
        dependencies(liveRegistry, {
          lockTimeoutMs: 0,
          processInstanceId: () => "2".repeat(64),
          processIsAlive: () => true,
        }),
      ),
    ).toThrow(/Timed out waiting for the local runtime registry lock/u);

    const legacyLiveRegistry = resolve(container, "legacy-live.json");
    mkdirSync(`${legacyLiveRegistry}.lock`);
    writeLockOwner(`${legacyLiveRegistry}.lock`, {
      nonce: "00000000-0000-4000-8000-000000000007",
      pid: process.pid,
    });
    expect(() =>
      allocateLocalRuntimePortBlock(
        third,
        {},
        dependencies(legacyLiveRegistry, {
          lockTimeoutMs: 0,
          processInstanceId: () => "2".repeat(64),
          processIsAlive: () => true,
        }),
      ),
    ).toThrow(/Timed out waiting for the local runtime registry lock/u);

    const ambiguousRegistry = resolve(container, "ambiguous.json");
    mkdirSync(`${ambiguousRegistry}.lock`);
    writeLockOwner(`${ambiguousRegistry}.lock`, {
      nonce: "00000000-0000-4000-8000-000000000005",
      pid: 123_457,
      processInstanceId: "5".repeat(64),
    });
    expect(() =>
      allocateLocalRuntimePortBlock(
        third,
        {},
        dependencies(ambiguousRegistry, {
          lockTimeoutMs: 0,
          processInstanceId: (pid) => (pid === process.pid ? "2".repeat(64) : undefined),
          processIsAlive: () => true,
        }),
      ),
    ).toThrow(/Timed out waiting for the local runtime registry lock/u);
  });

  it("keeps a young empty lock directory fail-closed", () => {
    const root = temporaryRoot();
    const registryPath = resolve(root, "allocations.json");
    const lockPath = `${registryPath}.lock`;
    mkdirSync(lockPath);

    expect(() =>
      allocateLocalRuntimePortBlock(root, {}, dependencies(registryPath, { lockTimeoutMs: 0 })),
    ).toThrow(/Timed out waiting for the local runtime registry lock/u);
    expect(readdirSync(lockPath)).toEqual([]);
  });

  it("reclaims an old empty lock directory", () => {
    const root = temporaryRoot();
    const registryPath = resolve(root, "allocations.json");
    const lockPath = `${registryPath}.lock`;
    mkdirSync(lockPath);
    const now = Date.now();
    utimesSync(lockPath, new Date(now - 6_000), new Date(now - 6_000));

    expect(
      allocateLocalRuntimePortBlock(
        root,
        {},
        dependencies(registryPath, { lockTimeoutMs: 0, now: () => now }),
      ).repositoryRoot,
    ).toBe(root);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not remove a replacement empty lock during stale recovery", () => {
    const root = temporaryRoot();
    const registryPath = resolve(root, "allocations.json");
    const lockPath = `${registryPath}.lock`;
    mkdirSync(lockPath);
    const original = statSync(lockPath, { bigint: true });
    const now = Date.now();
    utimesSync(lockPath, new Date(now - 6_000), new Date(now - 6_000));
    let clockReads = 0;
    const clock = () => {
      clockReads += 1;
      if (clockReads === 2) {
        renameSync(lockPath, `${lockPath}.original`);
        mkdirSync(lockPath);
      }
      return now;
    };

    expect(() =>
      allocateLocalRuntimePortBlock(
        root,
        {},
        dependencies(registryPath, { lockTimeoutMs: 0, now: clock }),
      ),
    ).toThrow(/Timed out waiting for the local runtime registry lock/u);
    const replacement = statSync(lockPath, { bigint: true });
    expect({ device: replacement.dev, inode: replacement.ino }).not.toEqual({
      device: original.dev,
      inode: original.ino,
    });
    expect(readdirSync(lockPath)).toEqual([]);
  });

  it("does not restore over a competing canonical acquisition when an owner appears", () => {
    const root = temporaryRoot();
    const registryPath = resolve(root, "allocations.json");
    const lockPath = `${registryPath}.lock`;
    mkdirSync(lockPath);
    const now = Date.now();
    utimesSync(lockPath, new Date(now - 6_000), new Date(now - 6_000));
    let clockReads = 0;
    let competitorIdentity: { readonly device: bigint; readonly inode: bigint } | undefined;
    const clock = () => {
      clockReads += 1;
      if (clockReads === 3) {
        const quarantineName = readdirSync(root).find((entry) =>
          entry.startsWith("allocations.json.lock.stale."),
        );
        if (!quarantineName) throw new Error("Expected a quarantined lock directory");
        const quarantinePath = resolve(root, quarantineName);
        writeLockOwner(quarantinePath, {
          nonce: "00000000-0000-4000-8000-000000000008",
          pid: process.pid,
          processInstanceId: "8".repeat(64),
        });
        mkdirSync(lockPath);
        const competitor = statSync(lockPath, { bigint: true });
        competitorIdentity = { device: competitor.dev, inode: competitor.ino };
      }
      return now;
    };

    expect(() =>
      allocateLocalRuntimePortBlock(
        root,
        {},
        dependencies(registryPath, { lockTimeoutMs: 0, now: clock }),
      ),
    ).toThrow(/lock ownership changed unexpectedly/u);
    const canonical = statSync(lockPath, { bigint: true });
    expect({ device: canonical.dev, inode: canonical.ino }).toEqual(competitorIdentity);
    expect(readdirSync(lockPath)).toEqual([]);
    expect(
      readdirSync(root).some((entry) => entry.startsWith("allocations.json.lock.stale.")),
    ).toBe(true);
  });

  it("does not remove a new live lock after a competing process reclaims the stale owner", async () => {
    const slowRoot = temporaryRoot("slow");
    const container = resolve(slowRoot, "..");
    const liveRoot = resolve(container, "live");
    mkdirSync(liveRoot);
    const registryPath = resolve(container, "allocations.json");
    const lockPath = `${registryPath}.lock`;
    const staleNonce = "00000000-0000-4000-8000-000000000003";
    const stalePid = 2_147_483_647;
    mkdirSync(lockPath);
    writeLockOwner(lockPath, {
      nonce: staleNonce,
      pid: stalePid,
      processInstanceId: "1".repeat(64),
    });

    const slowObserved = resolve(container, "slow-observed");
    const slowRelease = resolve(container, "slow-release");
    const slowSawLive = resolve(container, "slow-saw-live");
    const liveAcquired = resolve(container, "live-acquired");
    const liveRelease = resolve(container, "live-release");
    const moduleUrl = new URL("../src/local-allocation.ts", import.meta.url).href;
    const commonSource = [
      'import { existsSync, writeFileSync } from "node:fs";',
      `import { allocateLocalRuntimePortBlock } from ${JSON.stringify(moduleUrl)};`,
      "const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
      "const processIsAlive = (pid) => {",
      "try { process.kill(pid, 0); return true; }",
      "catch (error) { if (error?.code === 'ESRCH') return false; if (error?.code === 'EPERM') return true; throw error; }",
      "};",
    ];
    const slowSource = [
      ...commonSource,
      "const observedLiveness = (pid) => {",
      "if (pid === Number(process.env.TEST_STALE_PID)) {",
      "writeFileSync(process.env.TEST_SLOW_OBSERVED, 'observed');",
      "while (!existsSync(process.env.TEST_SLOW_RELEASE)) wait();",
      "return false;",
      "}",
      "const alive = processIsAlive(pid);",
      "if (pid !== process.pid) writeFileSync(process.env.TEST_SLOW_SAW_LIVE, 'live');",
      "return alive;",
      "};",
      "const allocation = allocateLocalRuntimePortBlock(process.env.TEST_RUNTIME_ROOT, {}, {",
      "candidatePortBases: [16000, 16016], ephemeralPortRange: [32768, 60999],",
      "listeningPorts: () => new Set(), processIsAlive: observedLiveness,",
      "registryPath: process.env.TEST_RUNTIME_REGISTRY,",
      "});",
      "process.stdout.write(JSON.stringify(allocation));",
    ].join("\n");
    const liveSource = [
      ...commonSource,
      "const allocation = allocateLocalRuntimePortBlock(process.env.TEST_RUNTIME_ROOT, {}, {",
      "candidatePortBases: [16000, 16016], ephemeralPortRange: [32768, 60999],",
      "listeningPorts: () => {",
      "writeFileSync(process.env.TEST_LIVE_ACQUIRED, 'acquired');",
      "while (!existsSync(process.env.TEST_LIVE_RELEASE)) wait();",
      "return new Set();",
      "},",
      "registryPath: process.env.TEST_RUNTIME_REGISTRY,",
      "});",
      "process.stdout.write(JSON.stringify(allocation));",
    ].join("\n");
    const run = (source: string, runtimeRoot: string, environment: NodeJS.ProcessEnv) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", source],
        {
          env: {
            ...process.env,
            ...environment,
            TEST_RUNTIME_REGISTRY: registryPath,
            TEST_RUNTIME_ROOT: runtimeRoot,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const result = new Promise<{ readonly portBase: number }>((resolveRun, reject) => {
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
      return { child, result };
    };

    const slow = run(slowSource, slowRoot, {
      TEST_SLOW_OBSERVED: slowObserved,
      TEST_SLOW_RELEASE: slowRelease,
      TEST_SLOW_SAW_LIVE: slowSawLive,
      TEST_STALE_PID: String(stalePid),
    });
    let live: ReturnType<typeof run> | undefined;
    try {
      await waitForPath(slowObserved);
      live = run(liveSource, liveRoot, {
        TEST_LIVE_ACQUIRED: liveAcquired,
        TEST_LIVE_RELEASE: liveRelease,
      });
      await waitForPath(liveAcquired);
      const [liveOwnerFile] = readdirSync(lockPath);
      if (!liveOwnerFile) throw new Error("Expected the live lock owner file");
      const liveOwner = JSON.parse(readFileSync(resolve(lockPath, liveOwnerFile), "utf8")) as {
        readonly pid: number;
      };
      expect(liveOwner.pid).toBe(live.child.pid);

      writeFileSync(slowRelease, "release");
      await waitForPath(slowSawLive);
      expect(readdirSync(lockPath)).toEqual([liveOwnerFile]);

      writeFileSync(liveRelease, "release");
      const allocations = await Promise.all([slow.result, live.result]);
      expect(new Set(allocations.map((allocation) => allocation.portBase)).size).toBe(2);
    } finally {
      writeFileSync(slowRelease, "release");
      writeFileSync(liveRelease, "release");
      if (slow.child.exitCode === null) slow.child.kill();
      if (live?.child.exitCode === null) live.child.kill();
      await Promise.allSettled([slow.result, ...(live ? [live.result] : [])]);
    }
  }, 10_000);

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
