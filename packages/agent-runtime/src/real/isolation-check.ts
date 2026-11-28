// コンテナの隔離が効いているかを、動かしているホストの Docker で確かめる。手順は docs/linux-isolation-check.md。
// 使い方: bun isolation-check.ts [--with-model]
// --with-model は CLAUDE_REAL_TOKEN と haiku を使い、プロセスの数を使い切ったときの CLI の終了コードも見る。
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type DockerConfig,
  type Sandbox,
  type TurnSandbox,
  dockerClientEnv,
  dockerRunArgs,
  dockerSandbox,
} from '../sandbox.ts'
import { agentImage, down, up } from './dev-env.ts'
import { askDirectly, realDockerConfig } from './support.ts'

const label = 'kurumi.agent=isolation-check'
const network = 'kurumi-iso-internal'
const gatewayName = 'kurumi-iso-gateway'
const mib = 1024 * 1024

type Verdict = 'PASS' | 'FAIL' | 'INFO'
const rows: { verdict: Verdict; id: string; what: string; observed: string }[] = []
const record = (verdict: Verdict, id: string, what: string, observed: string) => {
  rows.push({ verdict, id, what, observed })
  console.log(
    `[${verdict}] ${id} ${what}\n       観測: ${observed.replaceAll('\n', '\n             ')}`,
  )
}
const expectTrue = (ok: boolean, id: string, what: string, observed: string) =>
  record(ok ? 'PASS' : 'FAIL', id, what, observed)

type Result = { code: number; stdout: string; stderr: string }

const exec = async (
  cmd: string[],
  env?: Record<string, string | undefined>,
  timeoutMs = 60_000,
) => {
  const child = Bun.spawn(cmd, {
    env: env ?? process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  return { code, stdout: stdout.trim(), stderr: stderr.trim() } satisfies Result
}
const docker = (...args: string[]) => exec(['docker', ...args])
const dockerOk = async (...args: string[]) => {
  const r = await docker(...args)
  if (r.code !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

const dirs = (() => {
  const root = mkdtempSync(join(tmpdir(), 'kurumi-iso-'))
  const configDir = join(root, 'cfg')
  const workspaceDir = join(root, 'work')
  mkdirSync(configDir)
  mkdirSync(workspaceDir)
  return { root, configDir, workspaceDir }
})()

let sequence = 0
/** 本番の `dockerRunArgs` が作る引数の、イメージの手前までを使う。フラグが本番と食い違わない */
const hardened = (
  overrides: Partial<DockerConfig> = {},
  mounts: { configDir: string; workspaceDir: string } = dirs,
) => {
  const config: DockerConfig = {
    ...realDockerConfig,
    network,
    label,
    anthropicBaseUrl: `http://${gatewayName}:8080`,
    ...overrides,
  }
  const turn: TurnSandbox = {
    name: `kurumi-iso-${Date.now()}-${++sequence}`,
    ...mounts,
    token: 'kurumi-fake-isolation-check',
  }
  const options = { command: 'claude', args: [], env: {}, signal: new AbortController().signal }
  const args = dockerRunArgs(config, turn, options)
  return {
    name: turn.name,
    prefix: args.slice(0, args.indexOf(config.image) + 1),
    env: { ...process.env, ...dockerClientEnv(config, turn, options) },
  }
}

const inHardened = (command: string[], overrides: Partial<DockerConfig> = {}) => {
  const { prefix, env } = hardened(overrides)
  return exec(['docker', ...prefix, ...command], env)
}

const sh = (script: string, overrides: Partial<DockerConfig> = {}) =>
  inHardened(['sh', '-c', script], overrides)

const tryConnect = (host: string, port: number) =>
  sh(`timeout 4 bash -c 'exec 3<>/dev/tcp/${host}/${port}' && echo connected`)

const dnsAndEnvironment = async () => {
  const info = await dockerOk(
    'info',
    '--format',
    'docker={{.ServerVersion}} os={{.OperatingSystem}} kernel={{.KernelVersion}} arch={{.Architecture}} cgroup={{.CgroupVersion}} driver={{.Driver}} security={{.SecurityOptions}}',
  )
  record('INFO', 'E0', '環境', `${process.platform}/${process.arch}  ${info}`)

  const external = await sh('getent hosts example.com')
  expectTrue(
    external.code !== 0,
    'L1a',
    '--internal ネットワークで、外の名前が解決されない',
    `getent hosts example.com -> 終了コード ${external.code} ${external.stdout || external.stderr}`,
  )
  const internal = await sh(`getent hosts ${gatewayName}`)
  expectTrue(
    internal.code === 0,
    'L1b',
    '同じネットワークの中の名前（ゲートウェイ）は解決される',
    `getent hosts ${gatewayName} -> 終了コード ${internal.code} ${internal.stdout}`,
  )
  const resolv = await sh('cat /etc/resolv.conf')
  record('INFO', 'L1c', 'コンテナの /etc/resolv.conf', resolv.stdout)
}

const ownership = async () => {
  const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }
  const written = await sh('echo x > /work/own.txt && mkdir /work/d && echo y > /work/d/own.txt')
  const file = statSync(join(dirs.workspaceDir, 'own.txt'))
  const nested = statSync(join(dirs.workspaceDir, 'd', 'own.txt'))
  expectTrue(
    written.code === 0 && file.uid === me.uid && nested.uid === me.uid,
    'L2a',
    'ホストの利用者と同じ uid:gid で走らせると、マウントした作業場所のファイルの持ち主はホストの利用者',
    `終了コード ${written.code}。ホストから見た持ち主は ${file.uid}:${file.gid}（ホストの利用者は ${me.uid}:${me.gid}）`,
  )

  const other = join(dirs.root, 'other')
  mkdirSync(other, { mode: 0o777 })
  const { prefix, env } = hardened({ user: '4242:4242' }, { configDir: other, workspaceDir: other })
  const otherWrite = await exec(
    ['docker', ...prefix, 'sh', '-c', 'echo x > /work/other.txt && id -u'],
    env,
  )
  const otherFile = statSync(join(other, 'other.txt'))
  record(
    'INFO',
    'L2b',
    '別の uid（4242）で走らせたときの持ち主（Linux は 4242:4242、Docker Desktop for Mac は変換されて 501 になる見込み）',
    `終了コード ${otherWrite.code}。ホストから見た持ち主は ${otherFile.uid}:${otherFile.gid}`,
  )
}

const hardening = async () => {
  const readOnly = await sh('touch /root-should-fail')
  expectTrue(
    readOnly.code !== 0,
    'L3a',
    'ルートのファイルシステムは読み取り専用',
    `touch / -> 終了コード ${readOnly.code} ${readOnly.stderr}`,
  )
  const writable = await sh('touch /tmp/ok /work/ok /cfg/ok')
  expectTrue(
    writable.code === 0,
    'L3b',
    '/tmp、/work、/cfg には書ける',
    `終了コード ${writable.code} ${writable.stderr}`,
  )
  const caps = await sh('grep -E "CapEff|CapBnd|NoNewPrivs" /proc/self/status')
  expectTrue(
    /CapEff:\s+0+\b/.test(caps.stdout) && /NoNewPrivs:\s+1/.test(caps.stdout),
    'L3c',
    'capability が空で、no-new-privileges が有効',
    caps.stdout,
  )
  const cgroup = await sh('stat -fc %T /sys/fs/cgroup')
  record('INFO', 'L3d', 'cgroup の版（cgroup2fs なら v2）', cgroup.stdout)

  const pids = await sh(
    '(i=0; while [ $i -lt 400 ]; do sleep 20 & i=$((i+1)); done); read cur < /sys/fs/cgroup/pids.current; read max < /sys/fs/cgroup/pids.max; echo "pids.current=$cur pids.max=$max"',
  )
  expectTrue(
    /Cannot fork|Resource temporarily unavailable/i.test(pids.stderr),
    'L3e',
    'プロセスの数が上限（256）で止まり、fork が失敗する',
    `${pids.stdout} / ${pids.stderr.split('\n')[0] ?? ''}`,
  )

  const memory = await sh('cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max 2>&1', {
    limits: { memory: '256m' },
  })
  const [max, swap] = memory.stdout.split('\n')
  expectTrue(
    max === String(256 * mib) && swap === '0',
    'L3f',
    '--memory-swap を --memory と同じにすると、swap が 0 になる（メモリと swap の合計が上限になる）',
    `memory.max=${max} memory.swap.max=${swap}`,
  )
  const hog = await inHardened(
    ['bun', '-e', 'const a = []; for (;;) a.push(new Uint8Array(32 * 1024 * 1024).fill(1))'],
    { limits: { memory: '256m' } },
  )
  expectTrue(
    hog.code === 137,
    'L3g',
    '上限を超えてメモリを使うと、OOM で殺される（終了コード 137）',
    `終了コード ${hog.code}`,
  )

  const zombies = await sh(
    '(sleep 0.3 &); sleep 1.5; echo "zombies=$(ps -eo stat= | grep -c "^Z")"; echo "pid1=$(ps -o comm= -p 1)"; true',
  )
  expectTrue(
    /zombies=0/.test(zombies.stdout),
    'L3h',
    '--init が孤児を刈り取り、ゾンビが残らない',
    zombies.stdout.replaceAll('\n', ' '),
  )
}

const egress = async () => {
  const listener = Bun.serve({ port: 0, hostname: '0.0.0.0', fetch: () => new Response('host') })
  const port = listener.port ?? 0
  const agent = hardened()
  const peer = hardened()
  try {
    const reached = await sh(
      `bash -c 'exec 3<>/dev/tcp/${gatewayName}/8080; printf "GET / HTTP/1.0\\r\\n\\r\\n" >&3; head -1 <&3'`,
    )
    expectTrue(
      reached.stdout.includes('200'),
      'L4a',
      'ゲートウェイには届く',
      reached.stdout || reached.stderr,
    )

    const world = await tryConnect('1.1.1.1', 443)
    expectTrue(
      !world.stdout.includes('connected'),
      'L4b',
      '外の IP アドレス（1.1.1.1:443）には届かない',
      `終了コード ${world.code} ${world.stdout || world.stderr}`,
    )

    const gateways = (
      await dockerOk(
        'network',
        'inspect',
        '--format',
        '{{range .IPAM.Config}}{{.Gateway}} {{end}}',
        network,
      )
    ).split(' ')
    const bridgeGateway = (
      await dockerOk(
        'network',
        'inspect',
        '--format',
        '{{range .IPAM.Config}}{{.Gateway}}{{end}}',
        'bridge',
      )
    ).trim()
    const lan = Object.values(networkInterfaces())
      .flat()
      .flatMap((i) => (i && i.family === 'IPv4' && !i.internal ? [i.address] : []))
    const candidates = [
      ...new Set([...gateways.filter(Boolean), bridgeGateway, ...lan, 'host.docker.internal']),
    ]
    const leaked: string[] = []
    const notes: string[] = []
    for (const host of candidates) {
      const r = await tryConnect(host, port)
      notes.push(`${host} -> ${r.stdout.includes('connected') ? '届いた' : '届かない'}`)
      if (r.stdout.includes('connected')) leaked.push(host)
    }
    expectTrue(
      leaked.length === 0,
      'L4c',
      'ホスト（内部ネットワークのゲートウェイ、docker0、LAN、host.docker.internal）の待ち受けに届かない',
      notes.join('\n'),
    )

    await exec(
      [
        'docker',
        'run',
        '-d',
        ...agent.prefix.slice(1),
        'bun',
        '-e',
        "Bun.serve({ port: 9000, fetch: () => new Response('peer') })",
      ],
      agent.env,
    ).then((r) => {
      if (r.code !== 0) throw new Error(r.stderr)
    })
    await Bun.sleep(1500)
    const members = await dockerOk(
      'network',
      'inspect',
      '--format',
      '{{range .Containers}}{{.Name}} {{end}}',
      network,
    )
    record('INFO', 'L4d', 'ネットワークの参加者', members)
    const peerIp = await dockerOk(
      'inspect',
      '--format',
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
      agent.name,
    )
    const toPeer = await exec(
      [
        'docker',
        ...peer.prefix,
        'bash',
        '-c',
        `timeout 4 bash -c 'exec 3<>/dev/tcp/${peerIp}/9000' && echo connected`,
      ],
      peer.env,
    )
    expectTrue(
      !toPeer.stdout.includes('connected'),
      'L4e',
      '同じネットワークのほかのエージェントのコンテナには届かない',
      `${peerIp}:9000 -> ${toPeer.stdout.includes('connected') ? '届いた' : '届かない'}`,
    )
  } finally {
    await listener.stop(true)
  }
}

const startup = async () => {
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    await inHardened(['claude', '--version'])
    times.push(Math.round(performance.now() - start))
  }
  const sorted = times.toSorted((a, b) => a - b)
  record(
    'INFO',
    'L5',
    'コンテナの起動から `claude --version` の終了までの時間（ミリ秒、5 回）',
    `${times.join(', ')}  中央値 ${sorted[2]}`,
  )
}

const pidExhaustion = async () => {
  await up()
  const exits: string[] = []
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const inner: Sandbox = dockerSandbox({ ...realDockerConfig, label })
      let exitCode: number | null = null
      const sandbox: Sandbox = {
        ...inner,
        spawn: (turn, options) => {
          const child = inner.spawn(turn, options)
          child.on('exit', (code: number | null) => (exitCode = code))
          return child
        },
      }
      const outcome = await askDirectly(
        sandbox,
        dirs,
        "Run these three Bash tool calls in order, as three separate calls, each command unchanged. First: `dash -c 'i=0; while [ $i -lt 400 ]; do i=$((i+1)); sleep 300 & done'`. Second: the same command again. Third: `ls / | wc -l; ls /cfg | wc -l`. Then reply DONE.",
      ).then(
        (r) => `result ${r.subtype}`,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
      exits.push(`試行 ${attempt}: docker run の終了コード ${exitCode}（${outcome}）`)
      if (exitCode === 134) break
    }
  } finally {
    await down()
  }
  record(
    'INFO',
    'L3i',
    'プロセスの数を使い切ったあとの CLI の終了コード（背景の仕事を止める設定の無かった試作では 134 が出た）',
    exits.join('\n'),
  )
}

const cleanup = async () => {
  const ids = (await docker('ps', '-aq', '--filter', `label=${label}`)).stdout
    .split('\n')
    .filter(Boolean)
  if (ids.length > 0) await docker('rm', '-f', ...ids)
  await docker('network', 'rm', network)
}

const startGateway = async () => {
  await dockerOk('network', 'create', '--internal', '--label', label, network)
  await dockerOk(
    'run',
    '-d',
    '--name',
    gatewayName,
    '--network',
    network,
    '--label',
    label,
    agentImage,
    'bun',
    '-e',
    "Bun.serve({ port: 8080, fetch: () => new Response('gateway-ok') })",
  )
  await Bun.sleep(1500)
}

const main = async () => {
  await cleanup()
  await startGateway()
  const steps: [string, () => Promise<void>][] = [
    ['DNS と環境', dnsAndEnvironment],
    ['ファイルの持ち主', ownership],
    ['硬化フラグ', hardening],
    ['外向き通信の閉じ込め', egress],
    ['起動時間', startup],
    ...(process.argv.includes('--with-model')
      ? ([['プロセスの数を使い切ったときの CLI', pidExhaustion]] as [string, () => Promise<void>][])
      : []),
  ]
  for (const [name, step] of steps) {
    console.log(`\n== ${name}`)
    try {
      await step()
    } catch (error) {
      record(
        'FAIL',
        'ERR',
        `${name} の途中で例外`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  await cleanup()
  rmSync(dirs.root, { recursive: true, force: true })
  const failed = rows.filter((r) => r.verdict === 'FAIL')
  console.log(
    `\n== まとめ: PASS ${rows.filter((r) => r.verdict === 'PASS').length}、FAIL ${failed.length}、INFO ${rows.filter((r) => r.verdict === 'INFO').length}`,
  )
  for (const r of failed) console.log(`   FAIL ${r.id} ${r.what}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

if (import.meta.main) await main()
