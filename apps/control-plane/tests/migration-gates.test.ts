import { afterEach, describe, expect, it, vi } from 'vitest'

const database = vi.hoisted(() => ({
  setResetGate: vi.fn(),
}))

vi.mock('$lib/server/db', () => database)

import { resetConfigForTest } from '../src/lib/server/config'
import { PUT } from '../src/routes/internal/migration/reset-gates/+server'

const originalEnvironment = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnvironment }
  resetConfigForTest()
  vi.clearAllMocks()
})

function request(resetRequired: boolean): Request {
  return new Request('http://control-plane/internal/migration/reset-gates', {
    method: 'PUT',
    headers: {
      authorization: 'Bearer local-only-migration-api-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      identities: [
        {
          identity_id: 'bb86046e-c922-44a3-a85f-ba21042c2897',
          reset_required: resetRequired,
          source: 'migration-test',
        },
      ],
    }),
  })
}

describe('migration reset gates', () => {
  it('rejects attempts to clear a reset gate with the migration credential', async () => {
    const response = await PUT({ request: request(false) } as Parameters<typeof PUT>[0])

    expect(response.status).toBe(400)
    expect(database.setResetGate).not.toHaveBeenCalled()
  })

  it('allows the migration credential to assert a reset gate', async () => {
    database.setResetGate.mockResolvedValue(undefined)
    const response = await PUT({ request: request(true) } as Parameters<typeof PUT>[0])

    expect(response.status).toBe(200)
    expect(database.setResetGate).toHaveBeenCalledExactlyOnceWith({
      identityId: 'bb86046e-c922-44a3-a85f-ba21042c2897',
      source: 'migration-test',
    })
  })
})
