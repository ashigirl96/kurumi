// Exfil sink: logs whatever reaches it.
Bun.serve({
  port: 80,
  async fetch(req) {
    console.log(JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, body: await req.text() }))
    return new Response('sink')
  },
})
console.log('sink listening on :80')
