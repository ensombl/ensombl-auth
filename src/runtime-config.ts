import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ApplicationRuntime {
  applicationId: string;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
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
  managementToken?: string;
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

  constructor(projectId: string) {
    this.#projectId = projectId;
  }

  async initialize(): Promise<void> {
    const { stdout } = await execFileAsync(
      "bws",
      ["secret", "list", this.#projectId, "--output", "json", "--color", "no"],
      { maxBuffer: 10 * 1024 * 1024 },
    );
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
    const { stdout } = await execFileAsync("bws", args, { maxBuffer: 1024 * 1024 });
    const saved = JSON.parse(stdout) as BwsSecret;
    this.#secrets.set(key, saved);
  }
}
