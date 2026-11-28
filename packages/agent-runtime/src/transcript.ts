import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const maxTranscriptBytes = 64 * 1024 * 1024

const uuidsIn = (text: string) => {
  const uuids = new Set<string>()
  for (const line of text.split('\n')) {
    try {
      const row: unknown = JSON.parse(line)
      if (typeof row === 'object' && row !== null && 'uuid' in row && typeof row.uuid === 'string')
        uuids.add(row.uuid)
    } catch {}
  }
  return uuids
}

export const transcriptHolds = async (
  configDir: string,
  claudeSessionId: string,
  required: readonly string[],
) => {
  const projects = join(configDir, 'projects')
  const dirs = await readdir(projects).catch(() => [])
  for (const dir of dirs) {
    const file = join(projects, dir, `${claudeSessionId}.jsonl`)
    const stat = await lstat(file).catch(() => undefined)
    if (stat === undefined) continue
    // 会話記録はコンテナの中でエージェントが書けるので、リンクや FIFO を辿らず、大きさも抑える。
    if (!stat.isFile() || stat.size > maxTranscriptBytes) return false
    const text = await readFile(file, 'utf8').catch(() => undefined)
    if (text === undefined) return false
    const found = uuidsIn(text)
    return required.every((uuid) => found.has(uuid))
  }
  return false
}
