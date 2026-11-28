// Markdown table: wire probe x gateway, from out/wire-<gw>.json. Each cell: what the container got, then
// what reached the upstream or the sink (the evidence for "passed").
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { outDir } from './lab.ts'

const gws = ['ag', 'mg-host', 'mg-ctr']
const data = Object.fromEntries(gws.filter((g) => existsSync(join(outDir, `wire-${g}.json`))).map((g) => [g, JSON.parse(readFileSync(join(outDir, `wire-${g}.json`), 'utf8')) as Record<string, any>[]]))
const ids = (Object.values(data)[0] ?? []).map((r) => r['id'] as string)

const cell = (r: Record<string, any> | undefined) => {
  if (!r) return '-'
  if (r['ports']) return Object.entries(r['ports']).filter(([, v]) => v === 'open').map(([k]) => k).join(',') || 'none open'
  if (r['hits']) return `hits=${r['hits'].length} env=${r['envHasCanary']}`
  const status = String(r['status'] ?? '').replace('HTTP/1.1 ', '').replace(/^error: connect /, '')
  const up = (r['upstream'] as string[]).join('; ')
  const extra = [
    up && `upstream: ${up}`,
    r['followed']?.length ? `FOLLOWED: ${r['followed'].join('; ')}` : '',
    r['sink']?.length ? `SINK GOT ${r['sink'].length}` : '',
    r['canaryInResponse'] ? 'CANARY IN RESPONSE' : '',
    r['canaryAfterBase64Decode'] ? 'CANARY AFTER BASE64 DECODE' : '',
  ].filter(Boolean)
  return [status, ...extra].join(' / ').replaceAll('|', '\\|')
}

console.log(`| probe | what | ${Object.keys(data).join(' | ')} |`)
console.log(`|---|---|${Object.keys(data).map(() => '---').join('|')}|`)
for (const id of ids) {
  const what = data[Object.keys(data)[0]!]!.find((r) => r['id'] === id)?.['what'] ?? ''
  console.log(`| ${id} | ${what} | ${Object.keys(data).map((g) => cell(data[g]!.find((r) => r['id'] === id))).join(' | ')} |`)
}
