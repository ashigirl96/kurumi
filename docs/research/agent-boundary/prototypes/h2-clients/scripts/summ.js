// Condenses Claude Code stream-json on stdin to the lines that matter: tool calls, tool results, final result.
let buf = ''
process.stdin.on('data', (d) => (buf += d))
process.stdin.on('end', () => {
  for (const line of buf.split('\n')) {
    let j
    try { j = JSON.parse(line) } catch { if (line.trim()) console.log('raw:', line.slice(0, 300)); continue }
    const c = j.message?.content
    if (j.type === 'assistant' && Array.isArray(c)) for (const b of c) if (b.type === 'tool_use') console.log('tool_use:', b.name, JSON.stringify(b.input))
    if (j.type === 'user' && Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') console.log('tool_result:', JSON.stringify(b.content).slice(0, 500))
    if (j.type === 'system' && j.subtype === 'init') console.log('init: mcp_servers=', JSON.stringify(j.mcp_servers))
    if (j.type === 'result') console.log('result:', j.subtype, JSON.stringify(j.result).slice(0, 600))
  }
})
