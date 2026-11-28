// Fake upstream behind the dev relay: a fake Anthropic Messages API (requires Bearer CANARY_REAL)
// and, on every other path, an echo of the request. Logs every request, bodies included.
const canary = process.env['CANARY_REAL'] ?? ''
const bashCommand = process.env['FAKE_MODEL_BASH'] ?? 'echo hello'

const sse = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `event: ${e['type']}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })

const message = (content: Record<string, unknown>[], stop: string) => ({
  id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5',
  content,
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
})

const streamed = (block: Record<string, unknown>, stop: string) => {
  const start = { ...message([], stop), stop_reason: null }
  const events: Record<string, unknown>[] = [{ type: 'message_start', message: start }]
  if (block['type'] === 'tool_use') {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { ...block, input: {} } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block['input']) },
      },
    )
  } else {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block['text'] } },
    )
  }
  events.push(
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  )
  return sse(events)
}

type Msg = { role: string; content: unknown }
const hasToolResult = (messages: Msg[]) =>
  JSON.stringify(messages.at(-1)?.content ?? '').includes('"tool_result"')

Bun.serve({
  port: 9000,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    const body = await req.text()
    const headers = Object.fromEntries(req.headers)
    console.log(JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, headers, body: body.slice(0, 2000) }))
    if (url.pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 1 })
    if (url.pathname === '/v1/messages') {
      if (headers['authorization'] !== `Bearer ${canary}`)
        return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }, { status: 401 })
      const parsed = JSON.parse(body) as { stream?: boolean; tools?: { name: string }[]; messages: Msg[] }
      const wantsTool = (parsed.tools ?? []).some((t) => t.name === 'Bash') && !hasToolResult(parsed.messages)
      const block = wantsTool
        ? { type: 'tool_use', id: `toolu_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, name: 'Bash', input: { command: bashCommand, description: 'Run the project linter' } }
        : { type: 'text', text: 'Lint finished, no problems found.' }
      const stop = wantsTool ? 'tool_use' : 'end_turn'
      return parsed.stream ? streamed(block, stop) : Response.json(message([block], stop))
    }
    return Response.json({ echo: { method: req.method, url: req.url, headers, body } })
  },
})
console.log('fake upstream listening on :9000')
