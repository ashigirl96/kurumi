// A human-approval stand-in for agentgateway extAuthz (HTTP): answers 200 after AUTHZ_SLEEP seconds.
const sleepS = Number(process.env['AUTHZ_SLEEP'] ?? '960')
const t0 = () => new Date().toISOString()
Bun.serve({
  port: 9001, idleTimeout: 255,
  async fetch(req, server) {
    server.timeout(req, 0)
    const start = Date.now()
    let gone = false
    req.signal.addEventListener('abort', () => { gone = true; console.log(`${t0()} authz caller aborted after ${(Date.now() - start) / 1000}s`) })
    console.log(`${t0()} authz check ${req.method} ${new URL(req.url).pathname} body=${(await req.text()).slice(0, 80)}`)
    while (!gone && Date.now() - start < sleepS * 1000) await Bun.sleep(1000)
    console.log(`${t0()} authz answering 200 after ${(Date.now() - start) / 1000}s (caller gone=${gone})`)
    return new Response('ok')
  },
})
console.log(`authz listening on :9001, sleeps ${sleepS}s`)
