// Raw DNS A query: bun dnsq.ts <server> <name>. Prints rcode and answers, or the error.
import { createSocket } from 'node:dgram'

const [server = '127.0.0.11', name = 'example.com'] = process.argv.slice(2)
const id = Math.floor(Math.random() * 65535)
const header = Buffer.alloc(12)
header.writeUInt16BE(id, 0)
header.writeUInt16BE(0x0100, 2)
header.writeUInt16BE(1, 4)
const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]))
const query = Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])])
const rcodes = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED']

const socket = createSocket('udp4')
const timer = setTimeout(() => {
  console.log(JSON.stringify({ server, name, result: 'timeout after 4s' }))
  process.exit(2)
}, 4000)
socket.on('message', (msg) => {
  clearTimeout(timer)
  const flags = msg.readUInt16BE(2)
  const answers = msg.readUInt16BE(6)
  const ips = msg.length >= 4 && answers > 0 ? [...msg.subarray(msg.length - 4)].join('.') : null
  console.log(JSON.stringify({ server, name, rcode: rcodes[flags & 0xf] ?? flags & 0xf, answers, lastA: ips }))
  process.exit(0)
})
socket.on('error', (e) => {
  console.log(JSON.stringify({ server, name, error: String(e) }))
  process.exit(3)
})
socket.send(query, 53, server)
