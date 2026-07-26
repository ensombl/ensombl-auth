import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'

const heartbeatPath = `/tmp/ensombl-auth-local-invitation-reconciler-${process.pid}`
const children = [
  spawn('./node_modules/.bin/vite', ['dev'], {
    stdio: 'inherit',
    env: process.env,
  }),
  spawn('node', ['scripts/reconcile-invitations-worker.mjs'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CONTROL_PLANE_INTERNAL_URL: 'http://localhost:3400',
      INVITATION_RECONCILER_SECRET: 'local-only-invitation-reconciler-secret',
      RECONCILE_LIMIT: '100',
      RECONCILE_INTERVAL_MS: '5000',
      RECONCILE_HEARTBEAT_PATH: heartbeatPath,
    },
  }),
]

let stopping = false
async function stop(signal, exitCode) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal)
  }
  await Promise.allSettled(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve()
          const forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000)
          forceKill.unref()
          child.once('exit', () => {
            clearTimeout(forceKill)
            resolve()
          })
        }),
    ),
  )
  await rm(heartbeatPath, { force: true })
  process.exit(exitCode)
}

process.once('SIGINT', () => void stop('SIGINT', 130))
process.once('SIGTERM', () => void stop('SIGTERM', 143))

for (const child of children) {
  child.once('exit', (code, signal) => {
    if (stopping) return
    const exitCode = typeof code === 'number' ? code : signal ? 1 : 0
    void stop('SIGTERM', exitCode)
  })
}
