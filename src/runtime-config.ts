import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type BwsCommandRunner = (args: string[]) => Promise<{ stdout: string }>;
type Wait = (milliseconds: number) => Promise<unknown>;

const runBwsCommand: BwsCommandRunner = async (args) => {
  const { stdout } = await execFileAsync("bws", args, { maxBuffer: 10 * 1024 * 1024 });
  return { stdout };
};

export interface ApplicationRuntime {
  applicationId: string;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  managementServiceAccount: {
    userId: string;
    clientId: string;
    clientSecret: string;
  };
}

export interface ProductRuntime {
  projectId: string;
  ownerOrganizationId: string;
  applications: Record<string, ApplicationRuntime>;
  serviceAccounts?: Record<
    string,
    {
      userId: string;
      clientId: string;
      clientSecret: string;
      role: string;
    }
  >;
  localFixture?: {
    tenantOrganizationId: string;
    userId: string;
    email: string;
    role: string;
  };
}

export interface RuntimeConfig {
  issuer: string;
  consoleUrl: string;
  products: Record<string, ProductRuntime>;
}

interface BwsSecret {
  readonly id: string;
  readonly key: string;
  readonly value: string;
}

export async function readRuntimeConfig(path: string): Promise<RuntimeConfig | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RuntimeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeRuntimeConfig(path: string, config: RuntimeConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export class BwsRuntimeStore {
  readonly #projectId: string;
  readonly #secrets = new Map<string, BwsSecret>();
  readonly #runCommand: BwsCommandRunner;
  readonly #wait: Wait;

  constructor(projectId: string, runCommand = runBwsCommand, wait: Wait = delay) {
    this.#projectId = projectId;
    this.#runCommand = runCommand;
    this.#wait = wait;
  }

  async initialize(): Promise<void> {
    const { stdout } = await this.#execute([
      "secret",
      "list",
      this.#projectId,
      "--output",
      "json",
      "--color",
      "no",
    ]);
    const secrets = JSON.parse(stdout) as BwsSecret[];
    for (const secret of secrets) this.#secrets.set(secret.key, secret);
  }

  get(key: string): string | undefined {
    return this.#secrets.get(key)?.value;
  }

  async set(key: string, value: string): Promise<void> {
    const current = this.#secrets.get(key);
    if (current?.value === value) return;
    const args = current
      ? ["secret", "edit", current.id, "--value", value, "--output", "json", "--color", "no"]
      : ["secret", "create", key, value, this.#projectId, "--output", "json", "--color", "no"];
    const { stdout } = await this.#execute(args);
    const saved = JSON.parse(stdout) as BwsSecret;
    this.#secrets.set(key, saved);
  }

  async #execute(args: string[]): Promise<{ stdout: string }> {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        return await this.#runCommand(args);
      } catch (error) {
        const stderr =
          typeof error === "object" &&
          error !== null &&
          "stderr" in error &&
          typeof error.stderr === "string"
            ? error.stderr
            : "";
        if (!stderr.includes("429 Too Many Requests")) {
          throw new Error(`Bitwarden command failed: ${args.slice(0, 2).join(" ")}`);
        }
        if (attempt === 6) {
          throw new Error("Bitwarden remained rate limited after 6 attempts");
        }
        await this.#wait(attempt * 1_000);
      }
    }
    throw new Error("Unreachable Bitwarden retry state");
  }
}
