// Dumb TCP forwarder: bun tcp-fwd.ts <listen>:<host>:<port> ...  Stands in, on Docker Desktop for Mac,
// for the host bridge address a Linux host process would bind on the --internal network.
import { connect, createServer } from 'node:net'

for (const spec of process.argv.slice(2)) {
  const [listen, host, port] = spec.split(':')
  createServer((client) => {
    const up = connect(Number(port), host!)
    client.pipe(up).pipe(client)
    const close = () => (client.destroy(), up.destroy())
    up.on('error', close)
    client.on('error', close)
  }).listen(Number(listen), () => console.log(`fwd listening ${spec}`))
}
