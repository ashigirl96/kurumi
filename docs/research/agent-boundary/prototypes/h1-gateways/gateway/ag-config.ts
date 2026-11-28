// agentgateway v1.7.0 standalone config: base-URL routes, strict per-turn apiKey, backendAuth.
// The host "registers" a turn token by rewriting this watched file (atomic rename).
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const agConfigDir = join(import.meta.dir, '..', 'out', 'run', 'ag')

export const agConfig = (keys: readonly string[], canaryModel: string, canaryGh: string) => {
  const keyList = keys.length === 0 ? '[]' : `\n${keys.map((k) => `          - key: ${k}`).join('\n')}`
  const ghRead = `
      - path: { pathPrefix: /repos/a/b/ }
        method: GET
      - path: { exact: /echo }
        method: GET
      - path: { exact: /redirect }
        method: GET
      - path: { exact: /slow }
        method: GET`
  const gh = `
        backendAuth: { key: ${canaryGh} }
        backendTLS: { root: /pki/ca.crt, hostname: api.github.test }
      backends:
      - host: api.github.test:443`
  // Admin, stats and readiness addresses are left at their defaults on purpose (measured, U7).
  return `binds:
- port: 8080
  listeners:
  - protocol: HTTP
    routes:
    - name: model
      matches:
      - path: { exact: /v1/messages }
        method: POST
      - path: { exact: /v1/messages/count_tokens }
        method: POST
      policies:
        apiKey:
          mode: strict
          keys: ${keyList}
        backendAuth: { key: ${canaryModel} }
      backends:
      - host: model.test:9000
- port: 8081
  listeners:
  - protocol: HTTP
    routes:
    - name: github-read
      matches:${ghRead}
      policies:
        apiKey:
          mode: strict
          keys: ${keyList}${gh}
- port: 8082
  listeners:
  - protocol: HTTP
    routes:
    - name: github-read-mode-omitted
      matches:${ghRead}
      policies:
        apiKey:
          keys: ${keyList}${gh}
`
}

export const writeAgConfig = (keys: readonly string[], canaryModel: string, canaryGh: string) => {
  const tmp = join(agConfigDir, ".config.yaml.tmp")
  writeFileSync(tmp, agConfig(keys, canaryModel, canaryGh))
  renameSync(tmp, join(agConfigDir, "config.yaml"))
}

// Docker Desktop for Mac: a write from the Mac side of the bind mount raises no inotify event in the VM,
// so a running gateway gets the file through docker exec (an in-VM write) instead.
export const pushAgConfig = async (keys: readonly string[], canaryModel: string, canaryGh: string) => {
  const p = Bun.spawn(["docker", "exec", "-i", "kh1-ag", "sh", "-c", "cat > /cfg/.push.tmp && mv /cfg/.push.tmp /cfg/config.yaml"], { stdin: "pipe" })
  p.stdin.write(agConfig(keys, canaryModel, canaryGh))
  await p.stdin.end()
  if ((await p.exited) !== 0) throw new Error("docker exec config push failed")
}

if (import.meta.main) writeAgConfig(process.argv.slice(2), process.env['CANARY_MODEL'] ?? '', process.env['CANARY_GH'] ?? '')
