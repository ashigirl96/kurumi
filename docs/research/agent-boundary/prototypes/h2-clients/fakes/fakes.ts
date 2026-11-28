// Every fake upstream in one TLS server, routed by Host. Certs come from the fake "public" CA, so the
// names are the real ones (api.github.com, github.com, registry.npmjs.org, ...). Every credentialed
// route requires CANARY_REAL; each request is logged with the sha256 of the exact body bytes received.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'

const canary = process.env['CANARY_REAL']!
const out = process.env['OUT'] ?? '/out'
const certs = process.env['CERTS'] ?? '/certs'
const log = (o: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...o })
  appendFileSync(`${out}/fakes.jsonl`, line + '\n')
}
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const sh = (cmd: string, cwd = '/') => {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`)
  return r.stdout
}

// --- git: one bare repo a/b.git with a commit on main ---
const gitRoot = '/srv/git'
if (!existsSync(`${gitRoot}/a/b.git`)) {
  mkdirSync(`${gitRoot}/a`, { recursive: true })
  sh(`git init -q --bare -b main ${gitRoot}/a/b.git && git -C ${gitRoot}/a/b.git config http.receivepack true`)
  sh(`rm -rf /tmp/seed && git init -q -b main /tmp/seed && cd /tmp/seed && echo seed > README && git add README &&
      git -c user.name=seed -c user.email=seed@example.invalid commit -qm seed && git push -q ${gitRoot}/a/b.git main`)
}

// --- npm: a real tarball for left-pad-fake@1.0.0 ---
mkdirSync('/srv/npm/pkg', { recursive: true })
writeFileSync('/srv/npm/pkg/package.json', JSON.stringify({ name: 'left-pad-fake', version: '1.0.0', main: 'index.js' }))
writeFileSync('/srv/npm/pkg/index.js', 'module.exports = (s) => "  " + s\n')
const tgzName = sh('npm pack --silent', '/srv/npm/pkg').trim().split('\n').at(-1)!
const tgz = readFileSync(`/srv/npm/pkg/${tgzName}`)
const integrity = 'sha512-' + createHash('sha512').update(tgz).digest('base64')
const shasum = createHash('sha1').update(tgz).digest('hex')

// --- pypi: a hand-built wheel for fake-pkg 1.0.0 ---
sh(`python3 - <<'EOF'
import base64, hashlib, zipfile
files = {
  "fake_pkg/__init__.py": b"MARK = 'fake-pkg-ok'\\n",
  "fake_pkg-1.0.0.dist-info/METADATA": b"Metadata-Version: 2.1\\nName: fake-pkg\\nVersion: 1.0.0\\n",
  "fake_pkg-1.0.0.dist-info/WHEEL": b"Wheel-Version: 1.0\\nGenerator: h2\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
}
rec = []
for n, b in files.items():
  d = base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b"=").decode()
  rec.append(f"{n},sha256={d},{len(b)}")
rec.append("fake_pkg-1.0.0.dist-info/RECORD,,")
with zipfile.ZipFile("/srv/fake_pkg-1.0.0-py3-none-any.whl", "w") as z:
  for n, b in files.items(): z.writestr(n, b)
  z.writestr("fake_pkg-1.0.0.dist-info/RECORD", "\\n".join(rec) + "\\n")
EOF`)
const whl = readFileSync('/srv/fake_pkg-1.0.0-py3-none-any.whl')

// --- fake model (Anthropic Messages API, SSE) ---
const sse = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `event: ${e['type']}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
const reply = (block: Record<string, unknown>, stop: string, stream: boolean) => {
  const msg = {
    id: `msg_${crypto.randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
    content: [] as unknown[], stop_reason: null as string | null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  }
  if (!stream) return Response.json({ ...msg, content: [block], stop_reason: stop })
  const ev: Record<string, unknown>[] = [{ type: 'message_start', message: msg }]
  if (block['type'] === 'tool_use') {
    ev.push({ type: 'content_block_start', index: 0, content_block: { ...block, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block['input']) } })
  } else {
    ev.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block['text'] } })
  }
  ev.push({ type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' })
  return sse(ev)
}
type Msg = { role: string; content: unknown }
const model = (body: string) => {
  const p = JSON.parse(body) as { stream?: boolean; tools?: { name: string }[]; messages: Msg[]; system?: unknown }
  const all = JSON.stringify(p.messages)
  const last = JSON.stringify(p.messages.at(-1)?.content ?? '')
  const tools = (p.tools ?? []).map((t) => t.name)
  const done = last.includes('"tool_result"')
  const tool = (name: string, input: Record<string, unknown>) =>
    reply({ type: 'tool_use', id: `toolu_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, name, input }, 'tool_use', !!p.stream)
  const text = (t: string) => reply({ type: 'text', text: t }, 'end_turn', !!p.stream)
  // WebFetch's secondary call: the page content arrives in a user message with no tools offered.
  if (tools.length === 0) return text(`SUMMARY marker-present=${all.includes('DOCS-MARKER-42')}`)
  const used = p.messages.filter((m) => m.role === 'assistant' && Array.isArray(m.content))
    .flatMap((m) => (m.content as { type: string; name?: string }[]).filter((b) => b.type === 'tool_use').map((b) => b.name!))
  // Claude Code defers WebFetch and MCP tools behind ToolSearch; load the tool first, then call it.
  const want = (target: string | undefined, input: Record<string, unknown>) => {
    if (!target) return null
    if (used.includes(target)) return null
    if (tools.includes(target)) return tool(target, input)
    if (tools.includes('ToolSearch') && !used.includes('ToolSearch')) return tool('ToolSearch', { query: `select:${target}`, max_results: 5 })
    return text(`TOOL ${target} NOT OFFERED; tools=${tools.join(',')}`)
  }
  const url = /WEBFETCH_URL=(\S+?)["\\\s]/.exec(all)?.[1]
  if (url) { const r = want('WebFetch', { url, prompt: 'Return the marker on the page.' }); if (r) return r }
  if (all.includes('USE_MCP')) { const r = want('mcp__fake__echo', { text: 'hello from the fake model' }); if (r) return r }
  if (used.length && !done) return text('FINAL (no tool result)')
  return text(`FINAL used=${used.join(',')} last_tool_result=${done ? last.slice(0, 600) : '-'}`)
}

// --- helpers ---
const authed = (h: Headers) => {
  const a = h.get('authorization') ?? ''
  if (a === `Bearer ${canary}` || a === `token ${canary}`) return true
  if (a.startsWith('Basic ')) return atob(a.slice(6)).split(':').slice(1).join(':') === canary
  return false
}
const deny = () => new Response('{"message":"Bad credentials"}', { status: 401, headers: { 'www-authenticate': 'Basic realm="fake"', 'content-type': 'application/json' } })

const gql = (body: string) => {
  const p = JSON.parse(body) as { query: string; variables?: Record<string, unknown> }
  const q = p.query
  if (/createIssue/.test(q)) return { data: { createIssue: { issue: { id: 'I_1', number: 7, url: 'https://github.com/a/b/issues/7' } } } }
  if (/viewer/.test(q) && !/repository/.test(q)) return { data: { viewer: { login: 'fake-user', id: 'U_1' } } }
  if (/repository/.test(q)) return { data: { repository: {
    id: 'R_1', name: 'b', owner: { login: 'a' }, hasIssuesEnabled: true, viewerPermission: 'ADMIN', isArchived: false,
    defaultBranchRef: { name: 'main' }, issueTemplates: [], pullRequestTemplates: [], parent: null, mergeCommitAllowed: true,
    rebaseMergeAllowed: true, squashMergeAllowed: true, url: 'https://github.com/a/b', isPrivate: true,
  } } }
  return { data: { echo: p } }
}

async function cgiGit(req: Request, url: URL, body: Uint8Array) {
  const env: Record<string, string> = {
    GIT_PROJECT_ROOT: gitRoot, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'fake-user', REQUEST_METHOD: req.method,
    PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers.get('content-type') ?? '',
    CONTENT_LENGTH: String(body.length), PATH: process.env['PATH']!,
  }
  const ce = req.headers.get('content-encoding'); if (ce) env['HTTP_CONTENT_ENCODING'] = ce
  const gp = req.headers.get('git-protocol'); if (gp) env['GIT_PROTOCOL'] = gp
  const r = spawnSync('git', ['http-backend'], { env, input: body, maxBuffer: 64 << 20 })
  const outb = r.stdout as Buffer
  const split = outb.indexOf('\r\n\r\n') >= 0 ? outb.indexOf('\r\n\r\n') : outb.indexOf('\n\n')
  const sep = outb.indexOf('\r\n\r\n') >= 0 ? 4 : 2
  const head = outb.subarray(0, split).toString()
  const headers = new Headers(); let status = 200
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':'); if (i < 0) continue
    const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim()
    if (k.toLowerCase() === 'status') status = parseInt(v); else headers.set(k, v)
  }
  return new Response(outb.subarray(split + sep), { status, headers })
}

const seenNpm: string[] = []
let reqSeq = 0
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '')
  const raw = new Uint8Array(await req.arrayBuffer())
  const headers = Object.fromEntries(req.headers)
  let decoded = ''
  try { decoded = (headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : Buffer.from(raw)).toString('utf8') } catch { decoded = '(undecodable)' }
  const n = ++reqSeq
  log({ n, host, method: req.method, path: url.pathname + url.search, headers, len: raw.length, sha256: sha(raw), body: decoded.slice(0, 4000) })
  if (host === 'api.anthropic.com') { mkdirSync(`${out}/model-bodies`, { recursive: true }); writeFileSync(`${out}/model-bodies/${n}.json`, decoded) }

  if (host === 'api.anthropic.com') {
    if (url.pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 1 })
    if (url.pathname === '/v1/messages') return authed(req.headers) ? model(decoded) : Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }, { status: 401 })
    return Response.json({ error: 'not found' }, { status: 404 })
  }
  if (host === 'api.github.com') {
    if (!authed(req.headers)) return deny()
    const p = url.pathname.replace(/^\/api\/v3/, '').replace(/^\/api\/graphql$/, '/graphql')
    const oauth = { 'x-oauth-scopes': 'repo, gist', 'content-type': 'application/json' }
    if (p === '/graphql') return new Response(JSON.stringify(gql(decoded)), { headers: oauth })
    if (p === '/user') return new Response(JSON.stringify({ login: 'fake-user', id: 1 }), { headers: oauth })
    if (p === '/repos/a/b' && req.method === 'GET') return new Response(JSON.stringify({ id: 1, full_name: 'a/b', name: 'b', owner: { login: 'a' }, private: true, default_branch: 'main' }), { headers: oauth })
    if (p === '/repos/a/b/issues' && req.method === 'POST') return new Response(JSON.stringify({ number: 7, html_url: 'https://github.com/a/b/issues/7', title: JSON.parse(decoded).title }), { status: 201, headers: oauth })
    if (p === '/repos/a/b/issues') return new Response('[]', { headers: oauth })
    if (p === '/gists' && req.method === 'POST') return new Response(JSON.stringify({ id: 'g1', html_url: 'https://gist.github.com/g1' }), { status: 201, headers: oauth })
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: oauth })
  }
  if (host === 'github.com') {
    if (!authed(req.headers)) return deny()
    return cgiGit(req, url, raw)
  }
  if (host === 'registry.npmjs.org') {
    if (url.pathname === '/left-pad-fake' && req.method === 'GET') {
      return Response.json({ name: 'left-pad-fake', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {
        name: 'left-pad-fake', version: '1.0.0', main: 'index.js',
        dist: { tarball: `https://registry.npmjs.org/left-pad-fake/-/${tgzName}`, integrity, shasum },
      } } })
    }
    if (url.pathname === `/left-pad-fake/-/${tgzName}`) return new Response(tgz, { headers: { 'content-type': 'application/octet-stream' } })
    if (req.method === 'PUT') {
      if (!authed(req.headers)) return deny()
      seenNpm.push(url.pathname)
      return Response.json({ ok: true, id: url.pathname }, { status: 201 })
    }
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  if (host === 'pypi.org') {
    if (url.pathname === '/simple/fake-pkg/') {
      const link = `https://files.pythonhosted.org/packages/fa/ke/fake_pkg-1.0.0-py3-none-any.whl#sha256=${sha(whl)}`
      return new Response(`<!DOCTYPE html><html><body><a href="${link}">fake_pkg-1.0.0-py3-none-any.whl</a></body></html>`, { headers: { 'content-type': 'text/html' } })
    }
    return new Response('not found', { status: 404 })
  }
  if (host === 'files.pythonhosted.org') {
    if (url.pathname.endsWith('/fake_pkg-1.0.0-py3-none-any.whl')) return new Response(whl, { headers: { 'content-type': 'application/octet-stream' } })
    return new Response('not found', { status: 404 })
  }
  if (host === 'mcp.example.com') {
    if (!authed(req.headers)) return new Response('unauthorized', { status: 401 })
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
    const m = JSON.parse(decoded) as { id?: number; method: string; params?: Record<string, unknown> }
    if (m.id === undefined) return new Response(null, { status: 202 })
    const result = m.method === 'initialize'
      ? { protocolVersion: (m.params?.['protocolVersion'] as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } }
      : m.method === 'tools/list'
        ? { tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
        : m.method === 'tools/call'
          ? { content: [{ type: 'text', text: `MCP-ECHO ${JSON.stringify(m.params?.['arguments'])}` }] }
          : {}
    return Response.json({ jsonrpc: '2.0', id: m.id, result }, { headers: { 'mcp-session-id': 'sess-1' } })
  }
  if (host === 'docs.example.com') {
    return new Response('<html><head><title>Fake docs</title></head><body><h1>Fake docs page</h1><p>The marker is DOCS-MARKER-42.</p></body></html>', { headers: { 'content-type': 'text/html' } })
  }
  if (host === 'echo.example.com') {
    if (!authed(req.headers)) return deny()
    return Response.json({ method: req.method, path: url.pathname, len: raw.length, sha256: sha(raw) })
  }
  return new Response(`no fake for host ${host}`, { status: 421 })
}

Bun.serve({
  port: 443, idleTimeout: 255,
  tls: { cert: Bun.file(`${certs}/fakes.crt`), key: Bun.file(`${certs}/fakes.key`) },
  fetch: (req) => handle(req).catch((e) => { log({ error: String(e) }); return new Response('fake error', { status: 500 }) }),
})
console.log('fakes listening on :443')
