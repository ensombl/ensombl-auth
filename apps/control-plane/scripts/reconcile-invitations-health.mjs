import { readFile } from 'node:fs/promises'

const heartbeatPath =
  process.env.RECONCILE_HEARTBEAT_PATH ?? '/tmp/ensombl-invitation-reconciler-heartbeat'
const maxAgeMs = Number(process.env.RECONCILE_HEALTH_MAX_AGE_MS ?? '120000')
if (!Number.isInteger(maxAgeMs) || maxAgeMs < 5_000 || maxAgeMs > 900_000) process.exit(1)

try {
  const heartbeat = Number((await readFile(heartbeatPath, 'utf8')).trim())
  process.exit(Number.isFinite(heartbeat) && Date.now() - heartbeat <= maxAgeMs ? 0 : 1)
} catch {
  process.exit(1)
}
