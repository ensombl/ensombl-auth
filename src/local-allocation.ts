import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const localRuntimePortBlockSize = 16;

const allocationVersion = 1;
const firstNonPrivilegedPort = 1_024;
const lastPortBlockBase = 65_520;
const lockRetryMilliseconds = 25;
const lockTimeoutMilliseconds = 5_000;
const invalidLockStaleMilliseconds = 5_000;
const lockOwnerFilePattern =
  /^owner\.([0-9]+)\.([0-9]+)\.([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json$/u;
const standardFreightClaimsPorts = new Set([
  3_000, 3_306, 3_310, 4_200, 11_025, 18_025, 18_080, 24_455, 28_025, 29_000, 29_001, 33_306,
  55_432, 55_433,
]);

interface DirectoryIdentity {
  readonly device: string;
  readonly inode: string;
}

interface LocalRuntimeReservation extends DirectoryIdentity {
  readonly id: string;
  readonly portBase: number;
  readonly repositoryRoot: string;
}

interface LocalRuntimeRegistry {
  readonly reservations: readonly LocalRuntimeReservation[];
  readonly version: typeof allocationVersion;
}

interface LockIdentity extends DirectoryIdentity {
  readonly nonce: string;
}

interface LockOwner extends LockIdentity {
  readonly pid: number;
  readonly processInstanceId: string;
}

export interface LocalRuntimeAllocationReference {
  readonly id: string;
  readonly portBase: number;
  readonly registryPath: string;
  readonly repositoryRoot: string;
}

export interface LocalRuntimeAllocation extends LocalRuntimeAllocationReference {
  readonly created: boolean;
}

export interface LocalRuntimeAllocationDependencies {
  readonly candidatePortBases?: readonly number[];
  readonly directoryIdentity?: (path: string) => DirectoryIdentity | undefined;
  readonly ephemeralPortRange?: readonly [number, number];
  readonly hostEphemeralPortRange?: () => readonly [number, number] | undefined;
  readonly listeningPorts?: () => ReadonlySet<number>;
  readonly lockTimeoutMs?: number;
  readonly now?: () => number;
  readonly portBlockIsAvailable?: (ports: readonly number[]) => boolean;
  readonly processInstanceId?: (pid: number) => string | undefined;
  readonly processIsAlive?: (pid: number) => boolean;
  readonly registryPath?: string;
}

function systemErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function defaultRegistryPath(environment: Readonly<NodeJS.ProcessEnv>): string {
  const configured = environment.FREIGHTCLAIMS_LOCAL_RUNTIME_REGISTRY_PATH?.trim();
  if (configured) return resolve(configured);
  const parent = environment.XDG_STATE_HOME?.trim() || resolve(homedir(), ".local/state");
  return resolve(parent, "freightclaims", "local-runtime-allocations.json");
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: true });
  const details = lstatSync(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Local runtime registry directory is not a real directory: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && details.uid !== uid) {
    throw new Error(`Local runtime registry directory has a foreign owner: ${path}`);
  }
  if ((details.mode & 0o077) !== 0) {
    throw new Error(`Local runtime registry directory permissions are not private: ${path}`);
  }
}

function defaultDirectoryIdentity(path: string): DirectoryIdentity | undefined {
  try {
    const details = statSync(path, { bigint: true });
    if (!details.isDirectory()) throw new Error(`Local runtime root is not a directory: ${path}`);
    return { device: String(details.dev), inode: String(details.ino) };
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function validatedEphemeralPortRange(
  range: readonly [number, number],
  errorMessage: string,
): readonly [number, number] {
  const [first, last] = range;
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < firstNonPrivilegedPort ||
    last > 65_535 ||
    first > last
  ) {
    throw new Error(errorMessage);
  }
  return range;
}

function configuredEphemeralPortRange(
  value: string | undefined,
): readonly [number, number] | undefined {
  if (!value?.trim()) return undefined;
  const match = /^(\d+)-(\d+)$/u.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    throw new Error("LOCAL_RUNTIME_EPHEMERAL_PORT_RANGE is invalid");
  }
  return validatedEphemeralPortRange(
    [Number(match[1]), Number(match[2])],
    "LOCAL_RUNTIME_EPHEMERAL_PORT_RANGE is invalid",
  );
}

function defaultHostEphemeralPortRange(): readonly [number, number] | undefined {
  if (process.platform !== "linux") return undefined;
  const values = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
    .trim()
    .split(/\s+/u)
    .map(Number);
  if (values.length !== 2 || values[0] === undefined || values[1] === undefined) {
    throw new Error("The live host ephemeral port range is invalid");
  }
  return validatedEphemeralPortRange(
    [values[0], values[1]],
    "The live host ephemeral port range is invalid",
  );
}

function resolveEphemeralPortRange(
  environment: Readonly<NodeJS.ProcessEnv>,
  dependencies: LocalRuntimeAllocationDependencies,
): readonly [number, number] {
  if (dependencies.ephemeralPortRange) {
    return validatedEphemeralPortRange(
      dependencies.ephemeralPortRange,
      "The supplied ephemeral port range is invalid",
    );
  }
  const configured = configuredEphemeralPortRange(environment.LOCAL_RUNTIME_EPHEMERAL_PORT_RANGE);
  if (configured) return configured;

  let discovered: readonly [number, number] | undefined;
  try {
    discovered = (dependencies.hostEphemeralPortRange ?? defaultHostEphemeralPortRange)();
  } catch (error) {
    throw new Error(
      "Could not determine the live host ephemeral port range; set LOCAL_RUNTIME_EPHEMERAL_PORT_RANGE from the host TCP port policy",
      { cause: error },
    );
  }
  if (!discovered) {
    throw new Error(
      "This host does not expose its ephemeral port range; set LOCAL_RUNTIME_EPHEMERAL_PORT_RANGE from the host TCP port policy",
    );
  }
  return validatedEphemeralPortRange(discovered, "The live host ephemeral port range is invalid");
}

const portableTcpPortProbe = `
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

const ports = JSON.parse(readFileSync(0, "utf8"));

function canListen(port, host, ipv6Only = false) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") resolve(undefined);
      else reject(error);
    });
    server.listen({ exclusive: true, host, ipv6Only, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

let available = true;
for (const port of ports) {
  const ipv4 = await canListen(port, "0.0.0.0");
  const ipv6 = await canListen(port, "::", true);
  if (ipv4 === false || ipv6 === false) {
    available = false;
    break;
  }
  if (ipv4 === undefined && ipv6 === undefined) {
    throw new Error("No supported TCP address family is available");
  }
}
process.stdout.write(available ? "available" : "unavailable");
`;

function defaultPortBlockIsAvailable(ports: readonly number[]): boolean {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", portableTcpPortProbe],
    { encoding: "utf8", input: JSON.stringify(ports) },
  );
  if (result.error) {
    throw new Error("Could not inspect live host TCP listeners", { cause: result.error });
  }
  if (result.status !== 0 || !["available", "unavailable"].includes(result.stdout)) {
    throw new Error("Could not inspect live host TCP listeners", {
      cause: new Error(
        result.stderr.trim() || `Port probe exited with status ${String(result.status)}`,
      ),
    });
  }
  return result.stdout === "available";
}

function portBlockAvailability(
  dependencies: LocalRuntimeAllocationDependencies,
): (ports: readonly number[]) => boolean {
  if (dependencies.portBlockIsAvailable) return dependencies.portBlockIsAvailable;
  if (dependencies.listeningPorts) {
    const listeningPorts = dependencies.listeningPorts();
    return (ports) => ports.every((port) => !listeningPorts.has(port));
  }
  return defaultPortBlockIsAvailable;
}

function parseReservedPorts(value: string | undefined): ReadonlySet<number> {
  const ports = new Set(standardFreightClaimsPorts);
  if (!value?.trim()) return ports;
  for (const entry of value.split(",").map((part) => part.trim())) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(entry);
    if (!match) throw new Error(`LOCAL_RUNTIME_RESERVED_PORTS contains an invalid entry: ${entry}`);
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (
      !Number.isInteger(first) ||
      !Number.isInteger(last) ||
      first < firstNonPrivilegedPort ||
      last > 65_535 ||
      first > last
    ) {
      throw new Error(`LOCAL_RUNTIME_RESERVED_PORTS contains an invalid range: ${entry}`);
    }
    for (let port = first; port <= last; port += 1) ports.add(port);
  }
  return ports;
}

function portBlock(portBase: number): readonly number[] {
  return Array.from({ length: localRuntimePortBlockSize }, (_, offset) => portBase + offset);
}

function portBlockBaseIsValid(portBase: number): boolean {
  return (
    Number.isInteger(portBase) &&
    portBase >= firstNonPrivilegedPort &&
    portBase <= lastPortBlockBase &&
    portBase % localRuntimePortBlockSize === 0
  );
}

function portBlockIsStructurallyAllowed(
  portBase: number,
  ephemeralPortRange: readonly [number, number],
  reservedPorts: ReadonlySet<number>,
): boolean {
  if (!portBlockBaseIsValid(portBase)) {
    return false;
  }
  return portBlock(portBase).every(
    (port) =>
      (port < ephemeralPortRange[0] || port > ephemeralPortRange[1]) && !reservedPorts.has(port),
  );
}

function candidatePortBases(
  dependencies: LocalRuntimeAllocationDependencies,
  ephemeralPortRange: readonly [number, number],
  reservedPorts: ReadonlySet<number>,
): readonly number[] {
  const configured = dependencies.candidatePortBases;
  const candidates =
    configured ??
    Array.from(
      { length: (lastPortBlockBase - firstNonPrivilegedPort) / localRuntimePortBlockSize + 1 },
      (_, index) => firstNonPrivilegedPort + index * localRuntimePortBlockSize,
    );
  const unique = [...new Set(candidates)].sort((left, right) => left - right);
  if (configured?.some((portBase) => !portBlockBaseIsValid(portBase))) {
    throw new Error("A configured local runtime candidate port block is invalid");
  }
  return unique.filter((portBase) =>
    portBlockIsStructurallyAllowed(portBase, ephemeralPortRange, reservedPorts),
  );
}

function validateReservation(value: unknown): LocalRuntimeReservation {
  if (!value || typeof value !== "object") throw new Error("Invalid local runtime reservation");
  const reservation = value as Partial<LocalRuntimeReservation>;
  if (
    typeof reservation.repositoryRoot !== "string" ||
    resolve(reservation.repositoryRoot) !== reservation.repositoryRoot ||
    typeof reservation.id !== "string" ||
    !/^[a-f0-9]{16}$/u.test(reservation.id) ||
    typeof reservation.portBase !== "number" ||
    !portBlockBaseIsValid(reservation.portBase) ||
    typeof reservation.device !== "string" ||
    typeof reservation.inode !== "string"
  ) {
    throw new Error("Invalid local runtime reservation");
  }
  return reservation as LocalRuntimeReservation;
}

function readRegistry(path: string): LocalRuntimeRegistry {
  let document: string;
  try {
    const details = lstatSync(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`Local runtime registry is not a regular file: ${path}`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && details.uid !== uid) {
      throw new Error(`Local runtime registry has a foreign owner: ${path}`);
    }
    if ((details.mode & 0o077) !== 0) {
      throw new Error(`Local runtime registry permissions are not private: ${path}`);
    }
    document = readFileSync(path, "utf8");
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT")
      return { reservations: [], version: allocationVersion };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch (error) {
    throw new Error(`Local runtime registry is invalid JSON: ${path}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error(`Invalid local runtime registry: ${path}`);
  const registry = parsed as { readonly reservations?: unknown; readonly version?: unknown };
  if (registry.version !== allocationVersion || !Array.isArray(registry.reservations)) {
    throw new Error(`Unsupported local runtime registry: ${path}`);
  }
  const reservations = registry.reservations.map(validateReservation);
  const paths = new Set<string>();
  const ids = new Set<string>();
  const portBases = new Set<number>();
  for (const reservation of reservations) {
    if (
      paths.has(reservation.repositoryRoot) ||
      ids.has(reservation.id) ||
      portBases.has(reservation.portBase)
    ) {
      throw new Error(`Local runtime registry contains conflicting reservations: ${path}`);
    }
    paths.add(reservation.repositoryRoot);
    ids.add(reservation.id);
    portBases.add(reservation.portBase);
  }
  return { reservations, version: allocationVersion };
}

function writeRegistry(path: string, registry: LocalRuntimeRegistry): void {
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(registry, undefined, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (systemErrorCode(cleanupError) !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          "Could not update the local runtime registry",
        );
      }
    }
    throw error;
  }
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (systemErrorCode(error) === "ESRCH") return false;
    if (systemErrorCode(error) === "EPERM") return true;
    throw error;
  }
}

function processInstanceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultProcessInstanceId(pid: number): string | undefined {
  if (process.platform === "linux") {
    let stat: string;
    let bootId: string;
    try {
      stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
      bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") return undefined;
      throw new Error(`Could not inspect process instance ${String(pid)}`, { cause: error });
    }
    const commandEnd = stat.lastIndexOf(")");
    const startTime = commandEnd < 0 ? undefined : stat.slice(commandEnd + 2).split(" ")[19];
    if (!startTime || !/^\d+$/u.test(startTime) || !bootId) {
      throw new Error(`Could not inspect process instance ${String(pid)}`);
    }
    return processInstanceHash(`linux:${bootId}:${startTime}`);
  }

  const command =
    process.platform === "win32"
      ? {
          arguments: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ],
          executable: resolve(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
        }
      : {
          arguments: ["-o", "lstart=", "-p", String(pid)],
          executable: "/bin/ps",
        };
  const result = spawnSync(command.executable, command.arguments, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Could not inspect process instance ${String(pid)}`, { cause: result.error });
  }
  const identity = result.stdout.trim();
  if (result.status !== 0 || !identity) {
    if (!defaultProcessIsAlive(pid)) return undefined;
    throw new Error(`Could not inspect process instance ${String(pid)}`);
  }
  return processInstanceHash(`${process.platform}:${identity}`);
}

function lockOwnerFileName(owner: LockIdentity): string {
  return `owner.${owner.device}.${owner.inode}.${owner.nonce}.json`;
}

function removeIncompleteLock(lockPath: string): boolean {
  try {
    rmdirSync(lockPath);
    return true;
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return true;
    if (systemErrorCode(error) === "ENOTEMPTY") return false;
    throw error;
  }
}

function removeLock(lockPath: string, expectedOwner: LockIdentity): boolean {
  const expectedOwnerFile = lockOwnerFileName(expectedOwner);
  let entries: string[];
  try {
    entries = readdirSync(lockPath);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (entries.length === 0) return false;
  if (entries.length !== 1) {
    throw new Error(`Local runtime registry lock contains foreign files: ${lockPath}`);
  }
  if (entries[0] !== expectedOwnerFile) return false;
  const ownerPath = resolve(lockPath, expectedOwnerFile);
  try {
    unlinkSync(ownerPath);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  try {
    rmdirSync(lockPath);
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT") throw error;
  }
  return true;
}

function recoverStaleLock(
  lockPath: string,
  now: number,
  processInstanceId: (pid: number) => string | undefined,
  processIsAlive: (pid: number) => boolean,
): boolean {
  let details: BigIntStats;
  try {
    details = lstatSync(lockPath, { bigint: true });
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return true;
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Local runtime registry lock has a foreign owner: ${lockPath}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && details.uid !== BigInt(uid)) {
    throw new Error(`Local runtime registry lock has a foreign owner: ${lockPath}`);
  }
  const entries = readdirSync(lockPath);
  if (entries.length === 0) return false;
  if (entries.length !== 1) {
    throw new Error(`Local runtime registry lock contains foreign files: ${lockPath}`);
  }
  const [ownerFile] = entries;
  if (!ownerFile) {
    throw new Error(`Local runtime registry lock contains foreign files: ${lockPath}`);
  }
  const ownerFileMatch = lockOwnerFilePattern.exec(ownerFile);
  if (!ownerFileMatch?.[1] || !ownerFileMatch[2] || !ownerFileMatch[3]) {
    throw new Error(`Local runtime registry lock contains foreign files: ${lockPath}`);
  }
  const ownerIdentity: LockIdentity = {
    device: ownerFileMatch[1],
    inode: ownerFileMatch[2],
    nonce: ownerFileMatch[3],
  };
  if (ownerIdentity.device !== String(details.dev) || ownerIdentity.inode !== String(details.ino)) {
    throw new Error(`Local runtime registry lock has a foreign owner: ${lockPath}`);
  }
  try {
    const owner = JSON.parse(
      readFileSync(resolve(lockPath, ownerFile), "utf8"),
    ) as Partial<LockOwner>;
    if (
      typeof owner.pid !== "number" ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      owner.device !== ownerIdentity.device ||
      owner.inode !== ownerIdentity.inode ||
      owner.nonce !== ownerIdentity.nonce
    ) {
      throw new Error("invalid owner");
    }
    if (typeof owner.processInstanceId !== "string" || !owner.processInstanceId) return false;
    if (!processIsAlive(owner.pid)) return removeLock(lockPath, ownerIdentity);
    const currentProcessInstanceId = processInstanceId(owner.pid);
    if (!currentProcessInstanceId) return false;
    if (currentProcessInstanceId === owner.processInstanceId) return false;
    return removeLock(lockPath, ownerIdentity);
  } catch (error) {
    if (
      systemErrorCode(error) !== "ENOENT" &&
      !(error instanceof SyntaxError) &&
      !(error instanceof Error && error.message === "invalid owner")
    ) {
      throw error;
    }
    if (now - Number(details.mtimeMs) < invalidLockStaleMilliseconds) return false;
    return removeLock(lockPath, ownerIdentity);
  }
}

function withRegistryLock<Result>(
  registryPath: string,
  dependencies: LocalRuntimeAllocationDependencies,
  operation: () => Result,
): Result {
  ensurePrivateDirectory(dirname(registryPath));
  const lockPath = `${registryPath}.lock`;
  const now = dependencies.now ?? Date.now;
  const processInstanceId = dependencies.processInstanceId ?? defaultProcessInstanceId;
  const processIsAlive = dependencies.processIsAlive ?? defaultProcessIsAlive;
  const deadline = now() + (dependencies.lockTimeoutMs ?? lockTimeoutMilliseconds);
  const nonce = randomUUID();
  const pid = process.pid;
  const ownerProcessInstanceId = processInstanceId(pid);
  if (!ownerProcessInstanceId) {
    throw new Error(`Could not inspect current process instance ${String(pid)}`);
  }
  let owner: LockOwner | undefined;
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const details = lstatSync(lockPath, { bigint: true });
      const acquiredOwner: LockOwner = {
        device: String(details.dev),
        inode: String(details.ino),
        nonce,
        pid,
        processInstanceId: ownerProcessInstanceId,
      };
      try {
        writeFileSync(
          resolve(lockPath, lockOwnerFileName(acquiredOwner)),
          JSON.stringify(acquiredOwner),
          {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          },
        );
      } catch (error) {
        try {
          if (!removeLock(lockPath, acquiredOwner) && !removeIncompleteLock(lockPath)) {
            throw new Error(
              `Local runtime registry lock ownership changed unexpectedly: ${lockPath}`,
            );
          }
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Could not initialize the local runtime registry lock",
          );
        }
        throw error;
      }
      owner = acquiredOwner;
      break;
    } catch (error) {
      if (systemErrorCode(error) !== "EEXIST") throw error;
      if (recoverStaleLock(lockPath, now(), processInstanceId, processIsAlive)) continue;
      if (now() >= deadline) {
        throw new Error(`Timed out waiting for the local runtime registry lock: ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, lockRetryMilliseconds);
    }
  }
  if (!owner) throw new Error(`Could not acquire the local runtime registry lock: ${lockPath}`);
  let result: Result;
  try {
    result = operation();
  } catch (error) {
    try {
      if (!removeLock(lockPath, owner)) {
        throw new Error(`Local runtime registry lock ownership changed unexpectedly: ${lockPath}`);
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Local runtime registry operation and lock cleanup both failed",
      );
    }
    throw error;
  }
  if (!removeLock(lockPath, owner)) {
    throw new Error(`Local runtime registry lock ownership changed unexpectedly: ${lockPath}`);
  }
  return result;
}

function allocationId(repositoryRoot: string): string {
  return createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 16);
}

function cleanStaleReservations(
  reservations: readonly LocalRuntimeReservation[],
  portBlockIsAvailable: (ports: readonly number[]) => boolean,
  directoryIdentity: (path: string) => DirectoryIdentity | undefined,
): readonly LocalRuntimeReservation[] {
  return reservations.filter((reservation) => {
    const current = directoryIdentity(reservation.repositoryRoot);
    if (current?.device === reservation.device && current.inode === reservation.inode) {
      return true;
    }
    if (!portBlockIsAvailable(portBlock(reservation.portBase))) {
      throw new Error(
        `Cannot recover stale local runtime reservation ${reservation.id}: its port block is still active`,
      );
    }
    return false;
  });
}

function allocationFromReservation(
  reservation: LocalRuntimeReservation,
  registryPath: string,
  created: boolean,
): LocalRuntimeAllocation {
  return Object.freeze({
    created,
    id: reservation.id,
    portBase: reservation.portBase,
    registryPath,
    repositoryRoot: reservation.repositoryRoot,
  });
}

export function allocateLocalRuntimePortBlock(
  path: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  dependencies: LocalRuntimeAllocationDependencies = {},
): LocalRuntimeAllocation {
  const repositoryRoot = resolve(path);
  const registryPath = resolve(dependencies.registryPath ?? defaultRegistryPath(environment));
  const directoryIdentity = dependencies.directoryIdentity ?? defaultDirectoryIdentity;
  const owner = directoryIdentity(repositoryRoot);
  if (!owner) throw new Error(`Local runtime root does not exist: ${repositoryRoot}`);
  const id = allocationId(repositoryRoot);
  const ephemeralPortRange = resolveEphemeralPortRange(environment, dependencies);
  const reservedPorts = parseReservedPorts(environment.LOCAL_RUNTIME_RESERVED_PORTS);
  const candidates = candidatePortBases(dependencies, ephemeralPortRange, reservedPorts);
  const requestedPortBase = environment.LOCAL_RUNTIME_PORT_BASE?.trim();
  const overridePortBase = requestedPortBase ? Number(requestedPortBase) : undefined;
  if (
    overridePortBase !== undefined &&
    !portBlockIsStructurallyAllowed(overridePortBase, ephemeralPortRange, reservedPorts)
  ) {
    throw new Error(
      "LOCAL_RUNTIME_PORT_BASE must be an aligned, non-reserved, non-ephemeral port block",
    );
  }

  return withRegistryLock(registryPath, dependencies, () => {
    const portBlockIsAvailable = portBlockAvailability(dependencies);
    const registry = readRegistry(registryPath);
    const reservations = cleanStaleReservations(
      registry.reservations,
      portBlockIsAvailable,
      directoryIdentity,
    );
    const existing = reservations.find(
      (reservation) => reservation.repositoryRoot === repositoryRoot,
    );
    if (existing) {
      if (
        existing.id !== id ||
        existing.device !== owner.device ||
        existing.inode !== owner.inode
      ) {
        throw new Error(`Local runtime reservation has a foreign owner: ${repositoryRoot}`);
      }
      if (
        !portBlockIsStructurallyAllowed(existing.portBase, ephemeralPortRange, reservedPorts) ||
        (overridePortBase !== undefined && overridePortBase !== existing.portBase)
      ) {
        throw new Error(
          `Existing local runtime allocation ${existing.id} conflicts with host port policy`,
        );
      }
      if (reservations.length !== registry.reservations.length) {
        writeRegistry(registryPath, { reservations, version: allocationVersion });
      }
      return allocationFromReservation(existing, registryPath, false);
    }

    const foreignIdOwner = reservations.find((reservation) => reservation.id === id);
    if (foreignIdOwner) {
      throw new Error(
        `Local runtime allocation ID ${id} is already owned by ${foreignIdOwner.repositoryRoot}`,
      );
    }

    const claimed = new Set(reservations.map((reservation) => reservation.portBase));
    const blockIsClear = (portBase: number) =>
      !claimed.has(portBase) && portBlockIsAvailable(portBlock(portBase));
    let portBase: number | undefined;
    if (overridePortBase !== undefined) {
      if (!candidates.includes(overridePortBase) || !blockIsClear(overridePortBase)) {
        throw new Error(
          `Requested local runtime port block ${String(overridePortBase)} is unavailable`,
        );
      }
      portBase = overridePortBase;
    } else if (candidates.length > 0) {
      const digest = createHash("sha256").update(repositoryRoot).digest();
      const start = digest.readUInt32BE(4) % candidates.length;
      for (let offset = 0; offset < candidates.length; offset += 1) {
        const candidate = candidates[(start + offset) % candidates.length];
        if (candidate !== undefined && blockIsClear(candidate)) {
          portBase = candidate;
          break;
        }
      }
    }
    if (portBase === undefined) {
      throw new Error("No complete local runtime port block is available");
    }

    const reservation: LocalRuntimeReservation = { ...owner, id, portBase, repositoryRoot };
    writeRegistry(registryPath, {
      reservations: [...reservations, reservation].sort((left, right) =>
        left.repositoryRoot.localeCompare(right.repositoryRoot),
      ),
      version: allocationVersion,
    });
    return allocationFromReservation(reservation, registryPath, true);
  });
}

export function localRuntimeAllocationEnvironment(
  allocation: LocalRuntimeAllocationReference,
): NodeJS.ProcessEnv {
  return {
    FREIGHTCLAIMS_LOCAL_RUNTIME_REGISTRY_PATH: allocation.registryPath,
    LOCAL_RUNTIME_ID: allocation.id,
    LOCAL_RUNTIME_PORT_BASE: String(allocation.portBase),
    LOCAL_RUNTIME_ROOT: allocation.repositoryRoot,
  };
}

export function consumeLocalRuntimePortBlock(
  environment: Readonly<NodeJS.ProcessEnv>,
  dependencies: LocalRuntimeAllocationDependencies = {},
): LocalRuntimeAllocation {
  const repositoryRoot = environment.LOCAL_RUNTIME_ROOT?.trim();
  const id = environment.LOCAL_RUNTIME_ID?.trim();
  const portBase = Number(environment.LOCAL_RUNTIME_PORT_BASE);
  if (!repositoryRoot || !id || !Number.isInteger(portBase)) {
    throw new Error(
      "LOCAL_RUNTIME_ROOT, LOCAL_RUNTIME_ID, and LOCAL_RUNTIME_PORT_BASE must be supplied together",
    );
  }
  const resolvedRoot = resolve(repositoryRoot);
  if (id !== allocationId(resolvedRoot)) {
    throw new Error("The supplied local runtime allocation ID does not match its root");
  }
  const registryPath = resolve(dependencies.registryPath ?? defaultRegistryPath(environment));
  return withRegistryLock(registryPath, dependencies, () => {
    const registry = readRegistry(registryPath);
    const reservation = registry.reservations.find(
      (entry) => entry.repositoryRoot === resolvedRoot,
    );
    const current = (dependencies.directoryIdentity ?? defaultDirectoryIdentity)(resolvedRoot);
    if (
      !reservation ||
      reservation.id !== id ||
      reservation.portBase !== portBase ||
      reservation.device !== current?.device ||
      reservation.inode !== current.inode
    ) {
      throw new Error("The supplied local runtime allocation is unavailable or has diverged");
    }
    return allocationFromReservation(reservation, registryPath, false);
  });
}

export function releaseLocalRuntimePortBlock(
  allocation: LocalRuntimeAllocationReference,
  dependencies: LocalRuntimeAllocationDependencies = {},
): void {
  const registryPath = resolve(dependencies.registryPath ?? allocation.registryPath);
  withRegistryLock(registryPath, dependencies, () => {
    const registry = readRegistry(registryPath);
    const reservation = registry.reservations.find(
      (entry) => entry.repositoryRoot === allocation.repositoryRoot,
    );
    if (!reservation) return;
    const current = (dependencies.directoryIdentity ?? defaultDirectoryIdentity)(
      allocation.repositoryRoot,
    );
    if (
      reservation.id !== allocation.id ||
      reservation.portBase !== allocation.portBase ||
      reservation.device !== current?.device ||
      reservation.inode !== current.inode
    ) {
      throw new Error(`Refusing to release a foreign local runtime reservation: ${allocation.id}`);
    }
    if (!portBlockAvailability(dependencies)(portBlock(allocation.portBase))) {
      throw new Error(`Refusing to release active local runtime reservation: ${allocation.id}`);
    }
    writeRegistry(registryPath, {
      reservations: registry.reservations.filter((entry) => entry !== reservation),
      version: allocationVersion,
    });
  });
}
