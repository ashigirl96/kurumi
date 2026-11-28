import { afterAll, describe, expect, test } from 'bun:test'

import { startDevRelay } from './dev-relay.ts'

const server = startDevRelay('real-token-not-sent-anywhere', 0)
afterAll(() => server.stop(true))

describe('dev relay', () => {
  test('refuses a request that does not carry a turn token', async () => {
    const res = await fetch(new URL('/v1/messages', server.url), {
      method: 'POST',
      headers: { authorization: 'Bearer sk-ant-oat-something-real' },
    })
    expect(res.status).toBe(401)
  })

  test('refuses a request without credentials', async () => {
    expect((await fetch(new URL('/v1/messages', server.url), { method: 'POST' })).status).toBe(401)
  })

  test('answers the health check without forwarding', async () => {
    expect((await fetch(new URL('/healthz', server.url))).status).toBe(200)
  })
})
