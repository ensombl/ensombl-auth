import { rm, writeFile } from 'node:fs/promises'
import { reconcileInvitations, reconciliationConfig } from './invitation-reconciler-client.mjs'

const configuration = reconciliationConfig()
const intervalMs = Number(process.env.RECONCILE_INTERVAL_MS ?? '30000')
const heartbeatPath =
  process.env.RECONCILE_HEARTBEAT_PATH ?? '/tmp/ensombl-invitation-reconciler-heartbeat'
if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000) {
  throw new Error('RECONCILE_INTERVAL_MS must be an integer between 1000 and 300000')
}

const shutdown = new AbortController()
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  shutdown.abort()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

function waitForRetry(delayMs) {
  if (shutdown.signal.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout)
      resolve()
    }
    const timeout = setTimeout(() => {
      shutdown.signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    shutdown.signal.addEventListener('abort', onAbort, { once: true })
  })
}

try {
  let failures = 0
  while (!stopping) {
    try {
      const requestSignal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000)])
      const reconciled = await reconcileInvitations(configuration, requestSignal)
      failures = 0
      if (!stopping) {
        await writeFile(heartbeatPath, `${Date.now()}\n`, { mode: 0o600 })
        console.info(`Invitation reconciliation completed; count=${reconciled}.`)
      }
    } catch {
      if (!stopping) {
        failures += 1
        console.error(`Invitation reconciliation failed; consecutive_failures=${failures}.`)
      }
    }

    const backoff = Math.min(intervalMs * 2 ** Math.min(failures, 4), 300_000)
    await waitForRetry(backoff)
  }
} finally {
  await rm(heartbeatPath, { force: true })
}
