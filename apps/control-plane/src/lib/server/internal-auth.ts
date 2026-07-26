import { timingSafeEqual } from 'node:crypto'

export function hasBearer(request: Request, expected: string): boolean {
  const value = request.headers.get('authorization')
  if (!value?.startsWith('Bearer ')) return false

  const actual = Buffer.from(value.slice('Bearer '.length))
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}
