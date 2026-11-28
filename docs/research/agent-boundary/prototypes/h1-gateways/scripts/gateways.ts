// The three base-URL gateways behind one control surface the "host" uses: register / revoke a turn token.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { pushAgConfig } from '../gateway/ag-config.ts'
import { labRoutes, startGateway } from '../gateway/kurumi-gw.ts'
import { canaryGh, canaryModel, here, logsSince } from './lab.ts'

export type GatewayName = 'ag' | 'mg-host' | 'mg-ctr'

export type Gateway = {
  readonly name: GatewayName
  /** host name the turn container uses */
  readonly host: string
  /** the github route as reachable from the Mac host (measurement only) */
  readonly hostUrl: string
  readonly register: (token: string) => Promise<void>
  readonly revoke: (token: string) => Promise<void>
  readonly revokeAll: () => Promise<void>
  readonly logs: (since: string) => Promise<string>
  readonly stop: () => void
}

const ca = () => readFileSync(join(here, 'out', 'pki', 'ca.crt'), 'utf8')

export const hostRoutes = () =>
  labRoutes({ CANARY_MODEL: canaryModel, CANARY_GH: canaryGh, MODEL_UPSTREAM: 'http://127.0.0.1:19000', GH_UPSTREAM: 'https://localhost:18443', GH_CA: ca() }).map((r) => ({
    ...r,
    port: r.port + 10000,
  }))

export const waitStatus = async (url: string, token: string, want: (s: number) => boolean, timeoutMs = 15_000) => {
  const t0 = performance.now()
  while (performance.now() - t0 < timeoutMs) {
    const s = await fetch(url, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status, () => 0)
    if (want(s)) return performance.now() - t0
    await Bun.sleep(5)
  }
  return Number.NaN
}

export const gateway = (name: GatewayName): Gateway => {
  if (name === 'ag') {
    const keys = new Set<string>()
    const write = () => pushAgConfig([...keys], canaryModel, canaryGh)
    const url = 'http://127.0.0.1:28081/repos/a/b/issues'
    return {
      name,
      host: 'kh1-ag',
      hostUrl: 'http://127.0.0.1:28081',
      register: async (t) => {
        keys.add(t)
        await write()
        if (Number.isNaN(await waitStatus(url, t, (s) => s === 200))) throw new Error("agentgateway did not accept the new key")
      },
      revoke: async (t) => {
        keys.delete(t)
        await write()
      },
      revokeAll: async () => {
        keys.clear()
        await write()
      },
      logs: (since) => logsSince('kh1-ag', since),
      stop: () => {},
    }
  }
  if (name === 'mg-ctr') {
    const secret = readFileSync(join(here, 'out', 'run', 'admin-secret'), 'utf8')
    const admin = (path: string, body: object) =>
      fetch(`http://127.0.0.1:39901${path}`, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) }).then((r) => {
        if (!r.ok) throw new Error(`admin ${path} -> ${r.status}`)
      })
    return {
      name,
      host: 'kh1-mg',
      hostUrl: 'http://127.0.0.1:38081',
      register: (t) => admin('/register', { token: t, turn: t.slice(12, 20) }),
      revoke: (t) => admin('/revoke', { token: t }),
      revokeAll: () => admin('/revoke-all', {}),
      logs: (since) => logsSince('kh1-mg', since),
      stop: () => {},
    }
  }
  const lines: { at: string; line: string }[] = []
  const gw = startGateway(hostRoutes(), '127.0.0.1', (e) => void lines.push({ at: new Date().toISOString(), line: JSON.stringify(e) }))
  return {
    name,
    host: 'kh1-fwd',
    hostUrl: 'http://127.0.0.1:18081',
    register: async (t) => gw.register(t, t.slice(12, 20)),
    revoke: async (t) => gw.revoke(t),
    revokeAll: async () => gw.revokeAll(),
    logs: async (since) => lines.filter((l) => l.at >= since).map((l) => l.line).join('\n'),
    stop: () => gw.stop(),
  }
}
