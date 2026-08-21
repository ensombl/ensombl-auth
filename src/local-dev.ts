import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localAuthComposeEnvironment, localAuthRuntimeProfile } from "./local-profile.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function execute(arguments_: readonly string[], environment: NodeJS.ProcessEnv): void {
  const result = spawnSync("docker", ["compose", ...arguments_], {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `docker compose exited ${result.signal === null ? `with code ${String(result.status)}` : `after ${result.signal}`}`,
    );
  }
}

export function runLocalAuthDevelopment(path = repositoryRoot): void {
  const profile = localAuthRuntimeProfile(path);
  const environment = localAuthComposeEnvironment(profile);
  mkdirSync(resolve(path, ".local"), { recursive: true });
  execute(["up", "-d", "--wait"], environment);
  execute(["build", "product-bootstrap"], environment);
  execute(["run", "--rm", "product-bootstrap"], environment);
}

export function validateLocalAuthCompose(path = repositoryRoot): void {
  const profile = localAuthRuntimeProfile(path);
  execute(["config", "--quiet"], localAuthComposeEnvironment(profile));
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  if (process.argv[2] === "config") validateLocalAuthCompose();
  else if (process.argv.length > 2) throw new Error("Usage: pnpm dev");
  else runLocalAuthDevelopment();
}
