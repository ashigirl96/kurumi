// Fake DNS server: logs every query name and answers every A query with 10.66.66.66.
import { createSocket } from 'node:dgram'

const qname = (msg: Buffer) => {
  const labels: string[] = []
  let i = 12
  while (i < msg.length && msg[i] !== 0) {
    const len = msg[i]!
    labels.push(msg.subarray(i + 1, i + 1 + len).toString())
    i += len + 1
  }
  return { name: labels.join('.'), end: i + 5 }
}

const socket = createSocket('udp4')
socket.on('message', (msg, from) => {
  const { name, end } = qname(msg)
  const qtype = msg.readUInt16BE(end - 4)
  console.log(JSON.stringify({ at: new Date().toISOString(), from: `${from.address}:${from.port}`, name, qtype }))
  const question = msg.subarray(12, end)
  const header = Buffer.from(msg.subarray(0, 12))
  header.writeUInt16BE(0x8180, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(qtype === 1 ? 1 : 0, 6)
  header.writeUInt32BE(0, 8)
  const answer =
    qtype === 1
      ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 10, 66, 66, 66])
      : Buffer.alloc(0)
  socket.send(Buffer.concat([header, question, answer]), from.port, from.address)
})
socket.bind(53, '0.0.0.0', () => console.log('fake dns listening on :53/udp'))
