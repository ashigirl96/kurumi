// Raw TCP request: bun raw.ts <host> <port> <base64 request>. Prints the first 1200 bytes back.
import { connect } from 'node:net'

const [host = 'kp-gw', port = '8080', b64 = ''] = process.argv.slice(2)
let got = ''
const s = connect(Number(port), host, () => s.write(Buffer.from(b64, 'base64')))
s.setTimeout(4000, () => {
  console.log(got.slice(0, 1200) || '(no response within 4s)')
  process.exit(0)
})
s.on('data', (d) => (got += d.toString()))
s.on('end', () => {
  console.log(got.slice(0, 1200) || '(closed with no response)')
  process.exit(0)
})
s.on('error', (e) => {
  console.log(`error: ${e.message}`)
  process.exit(0)
})
