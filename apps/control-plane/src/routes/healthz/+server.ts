import { json } from '@sveltejs/kit'
import { config } from '$lib/server/config'
import { db } from '$lib/server/db'
import type { RequestHandler } from './$types'

async function reachable(url: URL): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

export const GET: RequestHandler = async () => {
  const configured = config()
  const checks = await Promise.all([
    db()`select 1`.then(
      () => true,
      () => false,
    ),
    reachable(new URL('health/ready', `${configured.KRATOS_ADMIN_URL}/`)),
    reachable(new URL('health/ready', `${configured.HYDRA_ADMIN_URL}/`)),
    reachable(new URL('health/ready', `${configured.KETO_READ_URL}/`)),
  ])
  const ready = checks.every(Boolean)
  return json(
    {
      status: ready ? 'ready' : 'not_ready',
      dependencies: {
        database: checks[0],
        kratos: checks[1],
        hydra: checks[2],
        keto: checks[3],
      },
    },
    { status: ready ? 200 : 503 },
  )
}
